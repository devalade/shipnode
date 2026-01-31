cmd_deploy() {
    load_config

    local SKIP_BUILD=false
    if [ "$1" = "--skip-build" ]; then
        SKIP_BUILD=true
    fi

    # Detect package manager
    PKG_MANAGER=$(detect_pkg_manager)
    PKG_INSTALL_CMD=$(get_pkg_install_cmd "$PKG_MANAGER")
    PKG_RUN_CMD=$(get_pkg_run_cmd "$PKG_MANAGER" "build")

    info "Deploying $APP_TYPE to $SSH_USER@$SSH_HOST..."

    # Create remote directory
    ssh -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "mkdir -p $REMOTE_PATH"

    if [ "$APP_TYPE" = "backend" ]; then
        deploy_backend
    else
        deploy_frontend "$SKIP_BUILD"
    fi
}

deploy_backend() {
    info "Deploying backend application..."

    # Check if package.json exists
    [ ! -f "package.json" ] && error "package.json not found in current directory"

    # Verify package manager is installed on remote server
    verify_remote_pkg_manager "$PKG_MANAGER"

    # Check if port is available or already used by this app
    if ! check_port_owner "$BACKEND_PORT" "$PM2_APP_NAME"; then
        local suggested_port
        suggested_port=$(suggest_available_port "$BACKEND_PORT")
        local current_owner
        current_owner=$(get_remote_port_process "$BACKEND_PORT")
        error "Port $BACKEND_PORT is already in use on $SSH_HOST

Current owner: $current_owner
Your app: $PM2_APP_NAME

Suggested fix:
  1. Update shipnode.conf: BACKEND_PORT=$suggested_port
  2. Check running apps:
     ssh $SSH_USER@$SSH_HOST -p $SSH_PORT 'pm2 list'
  3. Or stop the conflicting app:
     ssh $SSH_USER@$SSH_HOST -p $SSH_PORT 'pm2 stop $current_owner'

Deployment blocked to prevent port conflict."
    fi

    if [ "$ZERO_DOWNTIME" = "true" ]; then
        deploy_backend_zero_downtime
    else
        deploy_backend_legacy
    fi
}

deploy_backend_legacy() {
    info "Using legacy deployment (non-zero-downtime)..."

    # Rsync application files
    info "Syncing files to server..."
    rsync -avz --progress \
        --exclude 'node_modules' \
        --exclude '.env' \
        --exclude '.git' \
        --exclude '.gitignore' \
        --exclude 'shipnode.conf' \
        --exclude '*.log' \
        -e "ssh -p $SSH_PORT" \
        ./ "$SSH_USER@$SSH_HOST:$REMOTE_PATH/"

    success "Files synced"

    # Install dependencies
    info "Installing dependencies..."
    ssh -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
        set -e
        cd $REMOTE_PATH
        $PKG_INSTALL_CMD
ENDSSH

    # Run pre-deploy hook
    if ! run_pre_deploy_hook "$REMOTE_PATH"; then
        error "Pre-deploy hook failed, aborting deployment"
    fi

    # Start or reload with PM2
    info "Starting application with PM2..."
    local PKG_START_CMD=$(get_pkg_start_cmd "$PKG_MANAGER" "$PM2_APP_NAME")

    ssh -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
        set -e
        cd $REMOTE_PATH

        if pm2 describe $PM2_APP_NAME > /dev/null 2>&1; then
            pm2 reload $PM2_APP_NAME
        else
            if [ -f ecosystem.config.js ]; then
                pm2 start ecosystem.config.js
            else
                $PKG_START_CMD
            fi
        fi

        pm2 save
ENDSSH

    success "Backend deployed and running"

    # Run post-deploy hook
    run_post_deploy_hook

    # Optionally configure Caddy
    if [ -n "$DOMAIN" ]; then
        configure_caddy_backend
    fi

    info "Run 'shipnode status' to check app status"
}

deploy_backend_zero_downtime() {
    info "Using zero-downtime deployment..."

    # Acquire deployment lock
    info "Acquiring deployment lock..."
    acquire_deploy_lock
    trap release_deploy_lock EXIT
    success "Lock acquired"

    # Generate release timestamp
    local timestamp=$(generate_release_timestamp)
    local release_path=$(get_release_path "$timestamp")

    info "Creating release: $timestamp"

    # Setup release structure on first deploy
    info "Setting up release structure..."
    setup_release_structure
    success "Release structure ready"

    # Get previous release for potential rollback
    local previous_release=$(get_previous_release)

    # Rsync to new release directory
    info "Syncing files to release directory..."
    rsync -avz --progress \
        --exclude 'node_modules' \
        --exclude '.env' \
        --exclude '.git' \
        --exclude '.gitignore' \
        --exclude 'shipnode.conf' \
        --exclude '*.log' \
        -e "ssh -p $SSH_PORT" \
        ./ "$SSH_USER@$SSH_HOST:$release_path/"

    success "Files synced to $release_path"

    # Link shared resources and install dependencies
    info "Setting up release environment..."
    ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
        set -e
        cd $release_path

        # Link shared .env if it exists
        if [ -f $REMOTE_PATH/shared/.env ]; then
            ln -sf $REMOTE_PATH/shared/.env .env
        fi

        # Install dependencies
        $PKG_INSTALL_CMD
ENDSSH

    success "Release prepared"

    # Run pre-deploy hook
    if ! run_pre_deploy_hook "$release_path"; then
        error "Pre-deploy hook failed, aborting deployment"
    fi

    # Atomic symlink switch
    info "Switching to new release..."
    switch_symlink "$release_path"

    # Reload PM2
    info "Reloading application..."

    # Generate PM2 start command based on package manager
    local PKG_START_CMD=$(get_pkg_start_cmd "$PKG_MANAGER" "$PM2_APP_NAME")

    ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
        set -e
        cd $REMOTE_PATH/current

        if pm2 describe $PM2_APP_NAME > /dev/null 2>&1; then
            pm2 reload $PM2_APP_NAME --update-env
        else
            if [ -f ecosystem.config.js ]; then
                pm2 start ecosystem.config.js
            else
                $PKG_START_CMD
            fi
        fi

        pm2 save
ENDSSH

    # Wait for app to start
    sleep 3

    # Run health check if enabled
    if [ "$HEALTH_CHECK_ENABLED" = "true" ]; then
        if ! perform_health_check; then
            warn "Health check failed, rolling back..."
            if [ -n "$previous_release" ]; then
                rollback_to_release "$previous_release"
                record_release "$timestamp" "failed"
                error "Deployment failed, rolled back to $previous_release"
            else
                error "Health check failed and no previous release to rollback to"
            fi
        fi
    fi

    # Record successful release
    record_release "$timestamp" "success"
    success "Release $timestamp deployed successfully"

    # Run post-deploy hook
    run_post_deploy_hook

    # Cleanup old releases
    cleanup_old_releases

    # Configure Caddy if needed
    if [ -n "$DOMAIN" ]; then
        configure_caddy_backend
    fi

    info "Run 'shipnode status' to check app status"
}

deploy_frontend() {
    local SKIP_BUILD=$1
    info "Deploying frontend application..."

    # Build if package.json exists and not skipping
    if [ -f "package.json" ] && [ "$SKIP_BUILD" = false ]; then
        info "Building frontend..."
        $PKG_RUN_CMD || error "Build failed"
        success "Build complete"
    fi

    # Determine build directory
    local BUILD_DIR="dist"
    if [ -d "build" ]; then
        BUILD_DIR="build"
    elif [ -d "public" ]; then
        BUILD_DIR="public"
    fi

    [ ! -d "$BUILD_DIR" ] && error "$BUILD_DIR directory not found"

    if [ "$ZERO_DOWNTIME" = "true" ]; then
        deploy_frontend_zero_downtime "$BUILD_DIR"
    else
        deploy_frontend_legacy "$BUILD_DIR"
    fi
}

deploy_frontend_legacy() {
    local BUILD_DIR=$1

    # Rsync build directory
    info "Syncing $BUILD_DIR to server..."
    rsync -avz --progress --delete \
        -e "ssh -p $SSH_PORT" \
        "$BUILD_DIR/" "$SSH_USER@$SSH_HOST:$REMOTE_PATH/"

    success "Frontend deployed"

    # Run pre-deploy hook
    if ! run_pre_deploy_hook "$REMOTE_PATH"; then
        error "Pre-deploy hook failed, aborting deployment"
    fi

    # Configure Caddy
    if [ -n "$DOMAIN" ]; then
        configure_caddy_frontend
    else
        warn "No DOMAIN set. Configure Caddy manually to serve $REMOTE_PATH"
    fi

    # Run post-deploy hook
    run_post_deploy_hook
}

deploy_frontend_zero_downtime() {
    local BUILD_DIR=$1

    info "Using zero-downtime deployment..."

    # Acquire deployment lock
    acquire_deploy_lock
    trap release_deploy_lock EXIT

    # Generate release timestamp
    local timestamp=$(generate_release_timestamp)
    local release_path=$(get_release_path "$timestamp")

    info "Creating release: $timestamp"

    # Setup release structure
    setup_release_structure

    # Rsync build output to release directory
    info "Syncing $BUILD_DIR to release directory..."
    rsync -avz --progress --delete \
        -e "ssh -p $SSH_PORT" \
        "$BUILD_DIR/" "$SSH_USER@$SSH_HOST:$release_path/"

    success "Files synced to $release_path"

    # Run pre-deploy hook
    if ! run_pre_deploy_hook "$release_path"; then
        error "Pre-deploy hook failed, aborting deployment"
    fi

    # Atomic symlink switch
    info "Switching to new release..."
    switch_symlink "$release_path"

    # Record release
    record_release "$timestamp" "success"
    success "Release $timestamp deployed successfully"

    # Run post-deploy hook
    run_post_deploy_hook

    # Cleanup old releases
    cleanup_old_releases

    # Configure Caddy
    if [ -n "$DOMAIN" ]; then
        configure_caddy_frontend
    else
        warn "No DOMAIN set. Configure Caddy manually to serve $REMOTE_PATH/current"
    fi
}

configure_caddy_backend() {
    info "Configuring Caddy reverse proxy for $DOMAIN..."

    local CADDY_CONFIG="/etc/caddy/Caddyfile"

    ssh -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
        set -e

        # Backup existing Caddyfile
        [ -f $CADDY_CONFIG ] && cp $CADDY_CONFIG ${CADDY_CONFIG}.backup

        # Create Caddyfile
        cat > $CADDY_CONFIG << 'EOF'
$DOMAIN {
    reverse_proxy localhost:$BACKEND_PORT
    encode gzip

    log {
        output file /var/log/caddy/${PM2_APP_NAME}.log
    }
}
EOF

        # Reload Caddy
        caddy reload --config $CADDY_CONFIG
ENDSSH

    success "Caddy configured for $DOMAIN → localhost:$BACKEND_PORT"
}

configure_caddy_frontend() {
    info "Configuring Caddy static file server for $DOMAIN..."

    local CADDY_CONFIG="/etc/caddy/Caddyfile"
    local SERVE_PATH="$REMOTE_PATH"

    # Use current symlink if zero-downtime is enabled
    if [ "$ZERO_DOWNTIME" = "true" ]; then
        SERVE_PATH="$REMOTE_PATH/current"
    fi

    ssh -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
        set -e

        # Backup existing Caddyfile
        [ -f $CADDY_CONFIG ] && cp $CADDY_CONFIG ${CADDY_CONFIG}.backup

        # Create Caddyfile
        cat > $CADDY_CONFIG << 'EOF'
$DOMAIN {
    root * $SERVE_PATH
    file_server
    encode gzip

    try_files {path} /index.html

    log {
        output file /var/log/caddy/frontend.log
    }
}
EOF

        # Reload Caddy
        caddy reload --config $CADDY_CONFIG
ENDSSH

    success "Caddy configured for $DOMAIN → $SERVE_PATH"
}

# Show app status

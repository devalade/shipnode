cmd_migrate() {
    load_config

    if [ "$ZERO_DOWNTIME" != "true" ]; then
        error "Migration only needed when enabling zero-downtime deployment"
    fi

    warn "This will migrate your existing deployment to the release structure"
    warn "Existing files will be moved to a new release directory"
    read -p "Continue? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        info "Migration cancelled"
        exit 0
    fi

    info "Migrating to release structure..."

    # Detect package manager and verify it's available on remote
    PKG_MANAGER=$(detect_pkg_manager)
    if [ "$APP_TYPE" = "backend" ]; then
        verify_remote_pkg_manager "$PKG_MANAGER"
    fi

    local timestamp=$(generate_release_timestamp)

    # Generate ecosystem file for backend apps (always regenerate to ensure it's up to date)
    if [ "$APP_TYPE" = "backend" ]; then
        info "Generating PM2 ecosystem config..."
        ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "mkdir -p $REMOTE_PATH/shared"
        generate_ecosystem_file "$PKG_MANAGER" "$PM2_APP_NAME" "$REMOTE_PATH/current" \
            | ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "cat > $REMOTE_PATH/shared/ecosystem.config.cjs"
    fi

    ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
        set -e
        cd $REMOTE_PATH

        # Create structure
        mkdir -p releases shared .shipnode
        echo "[]" > .shipnode/releases.json

        # Move existing files to first release
        mkdir -p releases/$timestamp

        # Move all files except the new directories
        find . -maxdepth 1 -mindepth 1 \
            ! -name 'releases' \
            ! -name 'shared' \
            ! -name '.shipnode' \
            ! -name 'current' \
            -exec mv {} releases/$timestamp/ \;

        # Move .env to shared if it exists
        if [ -f releases/$timestamp/.env ]; then
            mv releases/$timestamp/.env shared/.env
            ln -sf $REMOTE_PATH/shared/.env releases/$timestamp/.env
        fi

        # Create current symlink
        ln -sfn releases/$timestamp current

        # Update PM2 to use current directory if backend
        if [ "$APP_TYPE" = "backend" ]; then
            if pm2 describe $PM2_APP_NAME > /dev/null 2>&1; then
                pm2 startOrReload $REMOTE_PATH/shared/ecosystem.config.cjs --update-env
                pm2 save
            fi
        fi

        # Record initial release
        CURRENT_DATE=\$(date -Is)
        jq ". + [{\"timestamp\":\"$timestamp\",\"date\":\"\$CURRENT_DATE\",\"status\":\"migrated\"}]" .shipnode/releases.json > .shipnode/releases.json.tmp
        mv .shipnode/releases.json.tmp .shipnode/releases.json
ENDSSH

    success "Migration complete"
    info "Your deployment now uses the release structure"
    info "Current release: $timestamp"

    # Update Caddy config
    if [ -n "$DOMAIN" ]; then
        info "Updating Caddy configuration..."
        if [ "$APP_TYPE" = "backend" ]; then
            configure_caddy_backend
        else
            configure_caddy_frontend
        fi
    fi
}

# Upload .env file to server

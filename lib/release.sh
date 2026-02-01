generate_release_timestamp() {
    date +"%Y%m%d%H%M%S"
}

get_release_path() {
    local timestamp=$1
    echo "$REMOTE_PATH/releases/$timestamp"
}

setup_release_structure() {
    ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
        mkdir -p $REMOTE_PATH/{releases,shared,.shipnode}
        if [ ! -f $REMOTE_PATH/.shipnode/releases.json ]; then
            echo "[]" > $REMOTE_PATH/.shipnode/releases.json
        fi
ENDSSH
}

acquire_deploy_lock() {
    local result
    result=$(ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash -s "$REMOTE_PATH" << 'ENDSSH'
        REMOTE_PATH="$1"
        mkdir -p "$REMOTE_PATH/.shipnode"
        LOCK_FILE="$REMOTE_PATH/.shipnode/deploy.lock"

        # Check for stale lock (older than 30 minutes)
        if [ -f "$LOCK_FILE" ]; then
            LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$LOCK_FILE") ))
            if [ "$LOCK_AGE" -gt 1800 ]; then
                echo "Removing stale lock file (${LOCK_AGE}s old)"
                rm -f "$LOCK_FILE"
            else
                echo "ERROR: Deployment in progress (lock age: ${LOCK_AGE}s)"
                exit 1
            fi
        fi

        # Create lock with timestamp
        date +%s > "$LOCK_FILE"
        echo "Lock acquired"
ENDSSH
    )
    echo "$result"
    if [[ "$result" == *"ERROR"* ]]; then
        error "Failed to acquire deployment lock"
    fi
}

release_deploy_lock() {
    ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "rm -f $REMOTE_PATH/.shipnode/deploy.lock" || true
}

switch_symlink() {
    local release_path=$1
    ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
        cd $REMOTE_PATH
        ln -sfn $release_path current.tmp
        mv -Tf current.tmp current
ENDSSH
}

perform_health_check() {
    local max_retries=${HEALTH_CHECK_RETRIES:-3}
    local timeout=${HEALTH_CHECK_TIMEOUT:-30}
    local path=${HEALTH_CHECK_PATH:-/health}
    local port=${BACKEND_PORT:-3000}

    info "Running health check (${max_retries} retries, ${timeout}s timeout)..."

    for i in $(seq 1 $max_retries); do
        if ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "timeout $timeout curl -sf http://localhost:$port$path" > /dev/null 2>&1; then
            success "Health check passed"
            return 0
        fi
        [ $i -lt $max_retries ] && warn "Health check attempt $i failed, retrying..."
        sleep 2
    done

    error "Health check failed after $max_retries attempts"
    return 1
}

record_release() {
    local timestamp=$1
    local status=$2
    ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
        cd $REMOTE_PATH/.shipnode
        CURRENT_DATE=\$(date -Is)
        jq ". + [{\"timestamp\":\"$timestamp\",\"date\":\"\$CURRENT_DATE\",\"status\":\"$status\"}]" releases.json > releases.json.tmp
        mv releases.json.tmp releases.json
ENDSSH
}

get_previous_release() {
    ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
        cd $REMOTE_PATH/.shipnode
        cat releases.json | jq -r '.[-2].timestamp // empty'
ENDSSH
}

cleanup_old_releases() {
    local keep=${KEEP_RELEASES:-5}
    ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
        cd $REMOTE_PATH/releases
        ls -t | tail -n +$((keep + 1)) | xargs -r rm -rf
ENDSSH
    info "Cleaned up old releases (keeping last $keep)"
}

rollback_to_release() {
    local timestamp=$1
    local release_path="$REMOTE_PATH/releases/$timestamp"

    info "Rolling back to release $timestamp..."
    switch_symlink "$release_path"

    if [ "$APP_TYPE" = "backend" ]; then
        ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
            set -e
            pm2 startOrReload $REMOTE_PATH/shared/ecosystem.config.cjs --update-env
            pm2 save
ENDSSH
    fi

    success "Rolled back to $timestamp"
}

# Run pre-deploy hook on remote server
# Returns: 0 on success, 1 on failure
run_pre_deploy_hook() {
    local release_path=$1
    local hook_script=${PRE_DEPLOY_SCRIPT:-".shipnode/pre-deploy.sh"}

    # Check if hook script exists locally
    if [ ! -f "$hook_script" ]; then
        return 0
    fi

    info "Running pre-deploy hook: $hook_script"

    # Copy hook script to release directory
    if ! scp -P "$SSH_PORT" "$hook_script" "$SSH_USER@$SSH_HOST:$release_path/.shipnode-pre-deploy.sh" 2>&1; then
        error "Failed to copy pre-deploy hook to server"
        return 1
    fi

    # Execute hook on remote server with output streaming (not captured)
    ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
        set -e
        cd $release_path

        # Export environment variables for hook
        export RELEASE_PATH="$release_path"
        export REMOTE_PATH="$REMOTE_PATH"
        export PM2_APP_NAME="${PM2_APP_NAME:-}"
        export BACKEND_PORT="${BACKEND_PORT:-}"
        export SHARED_ENV_PATH="$REMOTE_PATH/shared/.env"

        # Make hook executable and run it
        chmod +x .shipnode-pre-deploy.sh
        ./.shipnode-pre-deploy.sh

        # Cleanup hook script
        rm -f .shipnode-pre-deploy.sh
ENDSSH

    local exit_code=$?
    if [ $exit_code -eq 0 ]; then
        success "Pre-deploy hook completed"
        return 0
    else
        error "Pre-deploy hook failed (exit code: $exit_code)"
        return 1
    fi
}

# Run post-deploy hook on remote server
# Returns: 0 on success, 1 on failure (but deployment continues)
run_post_deploy_hook() {
    local current_path="$REMOTE_PATH/current"
    local hook_script=${POST_DEPLOY_SCRIPT:-".shipnode/post-deploy.sh"}

    # Check if hook script exists locally
    if [ ! -f "$hook_script" ]; then
        return 0
    fi

    info "Running post-deploy hook: $hook_script"

    # Copy hook script to current directory
    if ! scp -P "$SSH_PORT" "$hook_script" "$SSH_USER@$SSH_HOST:$current_path/.shipnode-post-deploy.sh" 2>&1; then
        warn "Failed to copy post-deploy hook to server"
        return 1
    fi

    # Execute hook on remote server with output streaming (not captured)
    ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
        set -e
        cd $current_path

        # Export environment variables for hook
        export RELEASE_PATH="$current_path"
        export REMOTE_PATH="$REMOTE_PATH"
        export PM2_APP_NAME="${PM2_APP_NAME:-}"
        export BACKEND_PORT="${BACKEND_PORT:-}"
        export SHARED_ENV_PATH="$REMOTE_PATH/shared/.env"

        # Make hook executable and run it
        chmod +x .shipnode-post-deploy.sh
        ./.shipnode-post-deploy.sh

        # Cleanup hook script
        rm -f .shipnode-post-deploy.sh
ENDSSH

    local exit_code=$?
    if [ $exit_code -eq 0 ]; then
        success "Post-deploy hook completed"
        return 0
    else
        warn "Post-deploy hook failed (deployment still successful, exit code: $exit_code)"
        return 1
    fi
}

# Setup PostgreSQL database

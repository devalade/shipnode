cmd_env() {
    load_config

    # Resolve environment file path (default to .env)
    LOCAL_ENV="${ENV_FILE:-.env}"

    # Check if environment file exists locally
    if [ ! -f "$LOCAL_ENV" ]; then
        error "Environment file not found: $LOCAL_ENV"
    fi

    info "Uploading $LOCAL_ENV to server..."

    # Determine target path based on deployment mode
    if [ "$ZERO_DOWNTIME" = "true" ]; then
        # Upload to shared directory for zero-downtime deployments
        TARGET_PATH="$REMOTE_PATH/shared/.env"
        ssh -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "mkdir -p $REMOTE_PATH/shared"
    else
        # Upload directly to app directory for legacy deployments
        TARGET_PATH="$REMOTE_PATH/.env"
        ssh -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "mkdir -p $REMOTE_PATH"
    fi

    # Upload the environment file
    scp -P "$SSH_PORT" "$LOCAL_ENV" "$SSH_USER@$SSH_HOST:$TARGET_PATH"

    success "Uploaded $LOCAL_ENV to $TARGET_PATH"

    # Restart backend app if running to reload env vars
    if [ "$APP_TYPE" = "backend" ]; then
        info "Restarting app to reload environment variables..."
        if ssh -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "pm2 describe $PM2_APP_NAME" &> /dev/null; then
            ssh -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "pm2 reload $PM2_APP_NAME"
            success "App restarted with new environment variables"
        else
            warn "App not running. Environment variables will be loaded on next deploy."
        fi
    fi
}

# Show help

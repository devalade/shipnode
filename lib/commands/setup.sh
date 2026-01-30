cmd_setup() {
    load_config

    info "Setting up server $SSH_USER@$SSH_HOST..."

    # Check SSH connection
    if ! ssh -o ConnectTimeout=10 -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "exit"; then
        error "Cannot connect to $SSH_USER@$SSH_HOST:$SSH_PORT"
    fi

    success "SSH connection successful"

    # Install Gum for enhanced UI (optional, non-blocking)
    echo ""
    info "Checking for Gum UI framework..."
    if ! install_gum; then
        warn "Continuing without Gum. The wizard will use classic prompts."
    fi

    # Install Node.js, PM2, and Caddy
    info "Installing dependencies on server..."

    # Set default Node.js version if not specified
    local node_version="${NODE_VERSION:-lts}"

    # Extract major version if full version is provided (e.g., 22.14.0 -> 22)
    if [[ "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        node_version=$(echo "$node_version" | cut -d. -f1)
        info "Extracted major version: $node_version"
    elif [[ "$node_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        node_version=$(echo "$node_version" | sed 's/^v//' | cut -d. -f1)
        info "Extracted major version: $node_version"
    fi

    info "Node.js version: $node_version"

    ssh -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << 'ENDSSH'
        NODE_VERSION="'"$node_version"'"
        set -e

        # Detect if running as root and set sudo prefix
        SUDO=""
        if [ "$EUID" -ne 0 ]; then
            SUDO="sudo"
        fi

        # Install jq for JSON manipulation
        if ! command -v jq &> /dev/null; then
            echo "Installing jq..."
            $SUDO apt-get update
            $SUDO apt-get install -y jq
        else
            echo "jq already installed: $(jq --version)"
        fi

        # Install Node.js (using NodeSource)
        if ! command -v node &> /dev/null; then
            echo "Installing Node.js $NODE_VERSION..."
            curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | $SUDO bash -
            $SUDO apt-get install -y nodejs
        else
            echo "Node.js already installed: $(node --version)"
        fi

        # Install PM2
        if ! command -v pm2 &> /dev/null; then
            echo "Installing PM2..."
            $SUDO npm install -g pm2
            pm2 startup systemd -u $USER --hp $HOME
        else
            echo "PM2 already installed: $(pm2 --version)"
        fi

        # Install Caddy
        if ! command -v caddy &> /dev/null; then
            echo "Installing Caddy..."
            $SUDO apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
            curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | $SUDO gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
            curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list
            $SUDO apt update
            $SUDO apt install -y caddy
        else
            echo "Caddy already installed: $(caddy version)"
        fi
ENDSSH

    # Install package manager if project needs one other than npm
    if [ -f "package.json" ]; then
        local detected_pm=$(detect_pkg_manager)
        info "Detected package manager: $detected_pm"

        if [ "$detected_pm" != "npm" ]; then
            install_remote_pkg_manager "$detected_pm"
        else
            success "npm already available (comes with Node.js)"
        fi
    else
        info "No package.json found, skipping package manager setup"
    fi

    # Setup PostgreSQL if enabled
    setup_postgresql

    success "Server setup complete"
    info "Ready to deploy with: shipnode deploy"
}

# Deploy application

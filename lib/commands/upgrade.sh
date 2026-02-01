cmd_upgrade() {
    local repo_url="https://github.com/devalade/shipnode"
    local latest_url="$repo_url/releases/latest/download/shipnode-installer.sh"
    local temp_dir="/tmp/shipnode-upgrade-$$"

    info "Checking for updates..."

    # Fetch latest version from GitHub API
    local latest_version
    local api_response
    local http_code

    # Use -w to get HTTP status code, -s for silent, -S to show errors
    api_response=$(curl -sSL -w "\n%{http_code}" "https://api.github.com/repos/devalade/shipnode/releases/latest" 2>/dev/null)
    http_code=$(echo "$api_response" | tail -n1)
    api_response=$(echo "$api_response" | head -n-1)

    if [ "$http_code" = "404" ]; then
        error "No releases available yet. Please check $repo_url/releases"
    elif [ "$http_code" != "200" ]; then
        error "Failed to fetch latest version from GitHub (HTTP $http_code)"
    fi

    # Extract version from tag_name field (e.g., "v1.2.0" -> "1.2.0")
    if command -v jq &> /dev/null; then
        # Use jq for robust JSON parsing
        latest_version=$(echo "$api_response" | jq -r '.tag_name' 2>/dev/null | sed 's/^v//')
    else
        # Fallback to grep for systems without jq
        latest_version=$(echo "$api_response" | grep -oP '"tag_name":\s*"v?\K[0-9.]+' | head -n1)
    fi

    if [ -z "$latest_version" ] || [ "$latest_version" = "null" ]; then
        error "Failed to parse version from GitHub API response"
    fi

    # Compare with current VERSION
    if [[ "$latest_version" == "$VERSION" ]]; then
        success "Already on latest version (v$VERSION)"
        return 0
    fi

    info "Current: v$VERSION → Latest: v$latest_version"

    # Create temp directory
    mkdir -p "$temp_dir"

    # Download latest installer
    info "Downloading ShipNode v$latest_version..."
    if ! curl -fsSL "$latest_url" -o "$temp_dir/shipnode-installer.sh"; then
        rm -rf "$temp_dir"
        error "Failed to download installer from $latest_url"
    fi

    # Extract the installer (it's a self-extracting script)
    info "Extracting installer..."

    # The installer has a base64 payload after __SHIPNODE_PAYLOAD__ marker
    # Extract and decode it
    local payload_marker="__SHIPNODE_PAYLOAD__"
    local payload_start
    payload_start=$(grep -n "^${payload_marker}$" "$temp_dir/shipnode-installer.sh" | head -n1 | cut -d: -f1)

    if [ -z "$payload_start" ]; then
        rm -rf "$temp_dir"
        error "Invalid installer format: payload marker not found"
    fi

    # Extract base64 payload and decode
    payload_start=$((payload_start + 1))
    if ! tail -n "+${payload_start}" "$temp_dir/shipnode-installer.sh" | base64 -d | tar -xz -C "$temp_dir"; then
        rm -rf "$temp_dir"
        error "Failed to extract installer payload"
    fi

    # Verify extraction
    if [ ! -f "$temp_dir/shipnode" ] || [ ! -d "$temp_dir/lib" ]; then
        rm -rf "$temp_dir"
        error "Extracted files are incomplete"
    fi

    # Install to SHIPNODE_DIR (overwrite existing installation)
    info "Installing to $SHIPNODE_DIR..."

    # Copy files
    cp -r "$temp_dir/shipnode" "$SHIPNODE_DIR/" || {
        rm -rf "$temp_dir"
        error "Failed to copy shipnode entry point"
    }

    cp -r "$temp_dir/lib" "$SHIPNODE_DIR/" || {
        rm -rf "$temp_dir"
        error "Failed to copy lib directory"
    }

    # Ensure executable
    chmod +x "$SHIPNODE_DIR/shipnode"

    # Cleanup
    rm -rf "$temp_dir"

    success "Upgraded to ShipNode v$latest_version"
    info "Restart your shell or run 'hash -r' to refresh the command cache"
}

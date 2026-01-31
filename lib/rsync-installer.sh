#!/usr/bin/env bash
#
# rsync-installer.sh - Rsync installer for Windows
#
# Ensures rsync is available on Windows systems by installing it via Git for Windows
#

# Check if rsync is available
has_rsync() {
    command -v rsync &> /dev/null
}

# Check if Git for Windows is installed
has_git_for_windows() {
    command -v git &> /dev/null && [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]
}

# Install rsync on Windows
install_rsync_windows() {
    info "Checking rsync availability on Windows..."
    
    if has_rsync; then
        success "rsync is already available ($(rsync --version | head -n1))"
        return 0
    fi
    
    warn "rsync is not installed on your system"
    
    # Check if Git for Windows is available
    if has_git_for_windows; then
        info "Git for Windows is installed but rsync is missing"
        info "rsync should be included in Git for Windows by default"
        warn "Try running this command from Git Bash instead of Command Prompt/PowerShell"
        error "Please run ShipNode from Git Bash to access rsync"
    fi
    
    # Git for Windows not found
    warn "rsync is required for deployment"
    echo ""
    echo "To install rsync on Windows, you have two options:"
    echo ""
    echo "Option 1: Git for Windows (Recommended)"
    echo "  1. Download from: https://git-scm.com/download/win"
    echo "  2. Run the installer (includes rsync)"
    echo "  3. Use Git Bash to run ShipNode"
    echo ""
    echo "Option 2: WSL (Windows Subsystem for Linux)"
    echo "  1. Open PowerShell as Administrator"
    echo "  2. Run: wsl --install"
    echo "  3. Restart your computer"
    echo "  4. In WSL terminal: sudo apt install rsync"
    echo "  5. Use WSL terminal to run ShipNode"
    echo ""
    
    error "Please install rsync and try again"
}

# Ensure rsync is available (cross-platform)
ensure_rsync() {
    # Detect OS
    local os_info
    IFS='|' read -r os_info _ <<< "$(detect_os)"
    
    # Check if rsync is available
    if has_rsync; then
        return 0
    fi
    
    # Only attempt installation on Windows
    if [ "$os_info" = "windows" ]; then
        install_rsync_windows
    else
        # On Linux/macOS, just error with instructions
        error "rsync is not installed. Please install it:
  Linux:   sudo apt install rsync (Ubuntu/Debian)
           sudo yum install rsync (RHEL/CentOS)
           sudo dnf install rsync (Fedora)
  macOS:   rsync is pre-installed (check if Xcode CLI tools are installed)"
    fi
}

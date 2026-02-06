#!/usr/bin/env bash
#
# rsync-installer.sh - Rsync installer for Windows
#
# Automatically installs rsync on Windows systems via Chocolatey or Scoop
#

# Check if rsync is available
has_rsync() {
    command -v rsync &> /dev/null
}

# Check if running in PowerShell/CMD vs Git Bash/WSL
is_native_windows() {
    [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]] && return 1
    [[ -n "$WSL_DISTRO_NAME" ]] && return 1
    [[ "$OS" == "Windows_NT" ]] && return 0
    return 1
}

# Check if Chocolatey is installed
has_chocolatey() {
    command -v choco &> /dev/null
}

# Check if Scoop is installed
has_scoop() {
    command -v scoop &> /dev/null
}

# Install rsync via Chocolatey
install_rsync_choco() {
    info "Installing rsync via Chocolatey..."
    
    if ! has_chocolatey; then
        info "Installing Chocolatey first..."
        powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))"
        
        if [ $? -ne 0 ]; then
            warn "Failed to install Chocolatey"
            return 1
        fi
        
        success "Chocolatey installed"
    fi
    
    info "Installing rsync package..."
    choco install rsync -y
    
    if [ $? -eq 0 ]; then
        success "rsync installed via Chocolatey"
        # Update PATH for current session
        export PATH="$PATH:/c/ProgramData/chocolatey/bin"
        return 0
    else
        warn "Failed to install rsync via Chocolatey"
        return 1
    fi
}

# Install rsync via Scoop
install_rsync_scoop() {
    info "Installing rsync via Scoop..."
    
    if ! has_scoop; then
        info "Installing Scoop first..."
        powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -Command "Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force; iex ((New-Object System.Net.WebClient).DownloadString('https://get.scoop.sh'))"
        
        if [ $? -ne 0 ]; then
            warn "Failed to install Scoop"
            return 1
        fi
        
        success "Scoop installed"
    fi
    
    info "Adding extras bucket and installing rsync..."
    scoop bucket add extras
    scoop install rsync
    
    if [ $? -eq 0 ]; then
        success "rsync installed via Scoop"
        return 0
    else
        warn "Failed to install rsync via Scoop"
        return 1
    fi
}

# Install rsync on Windows with automatic installation
install_rsync_windows() {
    info "Checking rsync availability on Windows..."
    
    if has_rsync; then
        success "rsync is already available ($(rsync --version | head -n1))"
        return 0
    fi
    
    warn "rsync is not installed on your system"
    
    # If in Git Bash or WSL, guide user
    if ! is_native_windows; then
        if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
            info "You are running in Git Bash"
            info "rsync should be available in Git for Windows"
            warn "Try running: pacman -S rsync"
            echo ""
            echo "Or reinstall Git for Windows with rsync option enabled"
        elif [[ -n "$WSL_DISTRO_NAME" ]]; then
            info "You are running in WSL"
            info "Installing rsync via apt..."
            sudo apt update && sudo apt install -y rsync
            
            if has_rsync; then
                success "rsync installed in WSL"
                return 0
            fi
        fi
        
        error "Failed to install rsync. Please install it manually and try again."
    fi
    
    # Native Windows (PowerShell/CMD) - try automatic installation
    info "Attempting automatic installation..."
    
    # Try Chocolatey first (more common)
    if install_rsync_choco; then
        if has_rsync; then
            success "rsync is now available!"
            return 0
        fi
    fi
    
    # Fallback to Scoop
    if install_rsync_scoop; then
        if has_rsync; then
            success "rsync is now available!"
            return 0
        fi
    fi
    
    # All methods failed - show manual instructions
    warn "Automatic installation failed"
    echo ""
    echo "Please install rsync manually using one of these methods:"
    echo ""
    echo "Option 1: Chocolatey (Recommended for Windows)"
    echo "  1. Open PowerShell as Administrator"
    echo "  2. Run: Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))"
    echo "  3. Run: choco install rsync -y"
    echo ""
    echo "Option 2: Git for Windows"
    echo "  1. Download from: https://git-scm.com/download/win"
    echo "  2. Run installer and select 'rsync' component"
    echo "  3. Use Git Bash to run ShipNode"
    echo ""
    echo "Option 3: WSL"
    echo "  1. Open PowerShell as Administrator"
    echo "  2. Run: wsl --install"
    echo "  3. Restart and run: sudo apt install rsync"
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

# ShipNode Installation Script for Windows (PowerShell)
# Usage: irm https://raw.githubusercontent.com/devalade/shipnode-v2/main/install.ps1 | iex

param(
    [string]$Version = "latest"
)

$ErrorActionPreference = "Stop"

Write-Host "ShipNode Installer" -ForegroundColor Green
Write-Host ""

# Check for Node.js
$NodePath = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodePath) {
    Write-Host "Error: Node.js is not installed." -ForegroundColor Red
    Write-Host "ShipNode requires Node.js >= 18."
    Write-Host ""
    Write-Host "Download from: https://nodejs.org/"
    exit 1
}

$NodeVersion = (node --version).Substring(1)
$RequiredVersion = [Version]"18.0.0"
$CurrentVersion = [Version]$NodeVersion

if ($CurrentVersion -lt $RequiredVersion) {
    Write-Host "Error: Node.js $NodeVersion is too old." -ForegroundColor Red
    Write-Host "ShipNode requires Node.js >= 18."
    exit 1
}

Write-Host "Node.js: $NodeVersion " -NoNewline
Write-Host "✓" -ForegroundColor Green

# Check for npm
$NpmPath = Get-Command npm -ErrorAction SilentlyContinue
if (-not $NpmPath) {
    Write-Host "Error: npm is not installed." -ForegroundColor Red
    exit 1
}

Write-Host "npm: $(npm --version) " -NoNewline
Write-Host "✓" -ForegroundColor Green
Write-Host ""

# Install ShipNode
Write-Host "Installing ShipNode via npm..." -ForegroundColor Green

if ($Version -eq "latest") {
    npm install -g shipnode
} else {
    npm install -g "shipnode@$Version"
}

# Verify installation
$ShipnodePath = Get-Command shipnode -ErrorAction SilentlyContinue

if ($ShipnodePath) {
    Write-Host ""
    Write-Host "✓ ShipNode installed successfully!" -ForegroundColor Green
    Write-Host ""
    
    try {
        & shipnode --version
    } catch {
        Write-Host "  shipnode installed"
    }
    
    Write-Host ""
    Write-Host "Quick start:"
    Write-Host "  shipnode init     # Create shipnode.config.ts"
    Write-Host "  shipnode setup    # Prepare your server"
    Write-Host "  shipnode deploy   # Deploy your app"
    Write-Host ""
    Write-Host "Run 'shipnode help' for all commands."
} else {
    Write-Host ""
    Write-Host "⚠ Installation completed, but 'shipnode' is not in your PATH." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Restart your terminal and try again."
}

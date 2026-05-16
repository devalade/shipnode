#!/usr/bin/env bash
set -e

# ShipNode Installation Script for Linux/macOS
# Usage: curl -fsSL https://raw.githubusercontent.com/devalade/shipnode-v2/main/install.sh | bash

REPO="devalade/shipnode-v2"
VERSION="${1:-latest}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${GREEN}ShipNode Installer${NC}"
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
  echo -e "${RED}Error: Node.js is not installed.${NC}"
  echo "ShipNode requires Node.js >= 18."
  echo ""
  echo "Install Node.js from: https://nodejs.org/"
  exit 1
fi

NODE_VERSION=$(node --version | sed 's/v//')
REQUIRED_VERSION="18.0.0"

# Simple version comparison
if [ "$(printf '%s\n' "$REQUIRED_VERSION" "$NODE_VERSION" | sort -V | head -n1)" != "$REQUIRED_VERSION" ]; then
  echo -e "${RED}Error: Node.js $NODE_VERSION is too old.${NC}"
  echo "ShipNode requires Node.js >= 18."
  exit 1
fi

echo -e "${BLUE}Node.js:${NC} $NODE_VERSION ✓"

# Check for npm
if ! command -v npm &> /dev/null; then
  echo -e "${RED}Error: npm is not installed.${NC}"
  exit 1
fi

echo -e "${BLUE}npm:${NC} $(npm --version) ✓"
echo ""

# Determine install method
if command -v npm &> /dev/null; then
  echo -e "${GREEN}Installing ShipNode via npm...${NC}"
  
  if [ "$VERSION" = "latest" ]; then
    npm install -g shipnode
  else
    npm install -g "shipnode@$VERSION"
  fi
else
  echo -e "${RED}Error: npm is required to install ShipNode.${NC}"
  exit 1
fi

# Verify installation
if command -v shipnode &> /dev/null; then
  echo ""
  echo -e "${GREEN}✓ ShipNode installed successfully!${NC}"
  echo ""
  shipnode --version 2>/dev/null || echo "  shipnode v$(npm list -g shipnode --depth=0 2>/dev/null | grep shipnode | sed 's/.*@//')"
  echo ""
  echo "Quick start:"
  echo "  shipnode init     # Create shipnode.config.ts"
  echo "  shipnode setup    # Prepare your server"
  echo "  shipnode deploy   # Deploy your app"
  echo ""
  echo "Run 'shipnode help' for all commands."
else
  echo ""
  echo -e "${YELLOW}⚠ Installation completed, but 'shipnode' is not in your PATH.${NC}"
  echo ""
  echo "Add this to your ~/.bashrc, ~/.zshrc, or ~/.config/fish/config.fish:"
  echo "  export PATH=\"\$PATH:$(npm bin -g 2>/dev/null || echo '\$HOME/.npm-global/bin')\""
  echo ""
  echo "Then reload your shell:"
  echo "  source ~/.bashrc   # or ~/.zshrc, etc."
fi

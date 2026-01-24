#!/usr/bin/env bash

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

VERSION="1.0.0"
DIST_DIR="dist"
ARCHIVE_NAME="shipnode-payload.tar.gz"
INSTALLER_NAME="shipnode-installer.sh"

echo -e "${BLUE}Building ShipNode v${VERSION} distribution...${NC}"

# Clean and create dist directory
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# Create temporary directory for packaging
TEMP_DIR=$(mktemp -d)
PACKAGE_DIR="$TEMP_DIR/shipnode"
mkdir -p "$PACKAGE_DIR"

echo -e "${BLUE}→${NC} Copying files..."

# Copy main files
cp shipnode "$PACKAGE_DIR/"
cp install.sh "$PACKAGE_DIR/"
cp uninstall.sh "$PACKAGE_DIR/"
cp shipnode.conf.example "$PACKAGE_DIR/"
cp LICENSE "$PACKAGE_DIR/"
cp README.md "$PACKAGE_DIR/"
cp INSTALL.md "$PACKAGE_DIR/"

# Copy templates
mkdir -p "$PACKAGE_DIR/templates"
cp templates/* "$PACKAGE_DIR/templates/"

# Create archive
echo -e "${BLUE}→${NC} Creating archive..."
cd "$TEMP_DIR"
tar -czf "$ARCHIVE_NAME" shipnode/
cd - > /dev/null

# Move archive to dist
mv "$TEMP_DIR/$ARCHIVE_NAME" "$DIST_DIR/"

# Create self-extracting installer
echo -e "${BLUE}→${NC} Creating self-extracting installer..."

cat > "$DIST_DIR/$INSTALLER_NAME" << 'EOF'
#!/usr/bin/env bash

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

VERSION="1.0.0"
INSTALL_DIR="$HOME/.shipnode"

echo -e "${BLUE}╔════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  ShipNode Installer v${VERSION}        ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════╝${NC}"
echo

# Check for required commands
for cmd in tar base64; do
    if ! command -v $cmd &> /dev/null; then
        echo -e "${RED}Error: $cmd is required but not installed${NC}"
        exit 1
    fi
done

# Extract embedded archive
echo -e "${BLUE}→${NC} Extracting ShipNode..."

# Create temp directory
TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"

# Extract the base64-encoded tar.gz from this script
ARCHIVE_LINE=$(awk '/^__ARCHIVE_BELOW__/ {print NR + 1; exit 0; }' "$0")
tail -n +${ARCHIVE_LINE} "$0" | base64 -d | tar -xz

# Check extraction
if [ ! -d "shipnode" ]; then
    echo -e "${RED}Error: Extraction failed${NC}"
    exit 1
fi

echo -e "${GREEN}✓${NC} Extracted successfully"

# Choose installation location
echo
echo "Choose installation location:"
echo "  1) $HOME/.shipnode (recommended)"
echo "  2) /opt/shipnode (system-wide, requires sudo)"
echo "  3) Custom path"
echo

read -p "Enter choice [1-3]: " -n 1 -r
echo

case $REPLY in
    1)
        INSTALL_DIR="$HOME/.shipnode"
        USE_SUDO=""
        ;;
    2)
        INSTALL_DIR="/opt/shipnode"
        USE_SUDO="sudo"
        ;;
    3)
        read -p "Enter installation path: " INSTALL_DIR
        INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"

        # Check if we need sudo
        if [[ "$INSTALL_DIR" == /opt/* ]] || [[ "$INSTALL_DIR" == /usr/* ]]; then
            USE_SUDO="sudo"
        else
            USE_SUDO=""
        fi
        ;;
    *)
        echo -e "${RED}Invalid choice${NC}"
        exit 1
        ;;
esac

# Install
echo -e "${BLUE}→${NC} Installing to $INSTALL_DIR..."

# Remove old installation if exists
if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}⚠${NC} Removing existing installation..."
    $USE_SUDO rm -rf "$INSTALL_DIR"
fi

# Create installation directory
$USE_SUDO mkdir -p "$INSTALL_DIR"

# Copy files
$USE_SUDO cp -r shipnode/* "$INSTALL_DIR/"

# Make shipnode executable
$USE_SUDO chmod +x "$INSTALL_DIR/shipnode"

echo -e "${GREEN}✓${NC} Files installed"

# Setup PATH
echo
echo "Choose how to make shipnode available:"
echo "  1) Symlink to /usr/local/bin (recommended, may require sudo)"
echo "  2) Add to PATH in ~/.bashrc"
echo "  3) Add to PATH in ~/.zshrc"
echo "  4) Both bashrc and zshrc"
echo "  5) Skip (manual setup)"
echo

read -p "Enter choice [1-5]: " -n 1 -r
echo

SHIPNODE_BIN="$INSTALL_DIR/shipnode"

case $REPLY in
    1)
        echo -e "${BLUE}→${NC} Creating symlink to /usr/local/bin..."
        sudo ln -sf "$SHIPNODE_BIN" /usr/local/bin/shipnode
        echo -e "${GREEN}✓${NC} Symlink created"

        # Verify
        if command -v shipnode &> /dev/null; then
            echo -e "${GREEN}✓${NC} Installation successful!"
        else
            echo -e "${YELLOW}⚠${NC} Symlink created but shipnode not in PATH. Check your PATH settings."
        fi
        ;;
    2)
        echo -e "${BLUE}→${NC} Adding to ~/.bashrc..."
        EXPORT_LINE="export PATH=\"$INSTALL_DIR:\$PATH\""

        if grep -q "$INSTALL_DIR" ~/.bashrc 2>/dev/null; then
            echo -e "${YELLOW}⚠${NC} Already in ~/.bashrc"
        else
            echo "" >> ~/.bashrc
            echo "# ShipNode" >> ~/.bashrc
            echo "$EXPORT_LINE" >> ~/.bashrc
            echo -e "${GREEN}✓${NC} Added to ~/.bashrc"
        fi

        echo -e "\n${BLUE}Run:${NC} source ~/.bashrc"
        echo -e "or restart your terminal to use shipnode"
        ;;
    3)
        echo -e "${BLUE}→${NC} Adding to ~/.zshrc..."
        EXPORT_LINE="export PATH=\"$INSTALL_DIR:\$PATH\""

        if grep -q "$INSTALL_DIR" ~/.zshrc 2>/dev/null; then
            echo -e "${YELLOW}⚠${NC} Already in ~/.zshrc"
        else
            echo "" >> ~/.zshrc
            echo "# ShipNode" >> ~/.zshrc
            echo "$EXPORT_LINE" >> ~/.zshrc
            echo -e "${GREEN}✓${NC} Added to ~/.zshrc"
        fi

        echo -e "\n${BLUE}Run:${NC} source ~/.zshrc"
        echo -e "or restart your terminal to use shipnode"
        ;;
    4)
        echo -e "${BLUE}→${NC} Adding to both ~/.bashrc and ~/.zshrc..."
        EXPORT_LINE="export PATH=\"$INSTALL_DIR:\$PATH\""

        # Bashrc
        if grep -q "$INSTALL_DIR" ~/.bashrc 2>/dev/null; then
            echo -e "${YELLOW}⚠${NC} Already in ~/.bashrc"
        else
            echo "" >> ~/.bashrc
            echo "# ShipNode" >> ~/.bashrc
            echo "$EXPORT_LINE" >> ~/.bashrc
            echo -e "${GREEN}✓${NC} Added to ~/.bashrc"
        fi

        # Zshrc
        if grep -q "$INSTALL_DIR" ~/.zshrc 2>/dev/null; then
            echo -e "${YELLOW}⚠${NC} Already in ~/.zshrc"
        else
            echo "" >> ~/.zshrc
            echo "# ShipNode" >> ~/.zshrc
            echo "$EXPORT_LINE" >> ~/.zshrc
            echo -e "${GREEN}✓${NC} Added to ~/.zshrc"
        fi

        echo -e "\n${BLUE}Run:${NC} source ~/.bashrc (or ~/.zshrc)"
        echo -e "or restart your terminal to use shipnode"
        ;;
    5)
        echo -e "${YELLOW}⚠${NC} Skipping PATH setup"
        echo -e "\nManual setup options:"
        echo -e "  1. Symlink: ${BLUE}sudo ln -s $SHIPNODE_BIN /usr/local/bin/shipnode${NC}"
        echo -e "  2. PATH: Add ${BLUE}export PATH=\"$INSTALL_DIR:\$PATH\"${NC} to your shell config"
        ;;
    *)
        echo -e "${RED}Invalid choice${NC}"
        exit 1
        ;;
esac

# Cleanup
cd - > /dev/null
rm -rf "$TEMP_DIR"

echo
echo -e "${GREEN}╔════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     Installation Complete! 🎉      ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════╝${NC}"
echo
echo "Quick start:"
echo -e "  ${BLUE}shipnode help${NC}       # View all commands"
echo -e "  ${BLUE}shipnode init${NC}       # Initialize a project"
echo -e "  ${BLUE}shipnode deploy${NC}     # Deploy your app"
echo
echo "Documentation: https://github.com/devalade/shipnode"
echo

exit 0

__ARCHIVE_BELOW__
EOF

# Append base64-encoded archive to installer
base64 "$DIST_DIR/$ARCHIVE_NAME" >> "$DIST_DIR/$INSTALLER_NAME"

# Make installer executable
chmod +x "$DIST_DIR/$INSTALLER_NAME"

# Cleanup
rm -rf "$TEMP_DIR"
rm "$DIST_DIR/$ARCHIVE_NAME"

echo -e "${GREEN}✓${NC} Build complete!"
echo
echo -e "${GREEN}Distribution created:${NC}"
echo -e "  ${BLUE}$DIST_DIR/$INSTALLER_NAME${NC}"
echo
echo "File size: $(du -h "$DIST_DIR/$INSTALLER_NAME" | cut -f1)"
echo
echo "Usage:"
echo -e "  ${BLUE}bash $DIST_DIR/$INSTALLER_NAME${NC}"
echo
echo "Or upload to GitHub releases for users to download:"
echo -e "  ${BLUE}curl -fsSL https://github.com/devalade/shipnode/releases/latest/download/shipnode-installer.sh | bash${NC}"
echo

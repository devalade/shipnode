#!/usr/bin/env bash

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

VERSION="1.1.1"
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

# Copy lib directory
mkdir -p "$PACKAGE_DIR/lib"
cp -r lib/* "$PACKAGE_DIR/lib/"

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
{
set -e

# Detect pipe execution and re-download to temp file
if [ ! -f "$0" ] || [ "$(basename "$0")" = "bash" ] || [ "$(basename "$0")" = "sh" ]; then
    SELF_TEMP=$(mktemp /tmp/shipnode-installer.XXXXXX)
    DOWNLOAD_URL="https://github.com/devalade/shipnode/releases/latest/download/shipnode-installer.sh"

    # Colors for download message
    BLUE='\033[0;34m'
    NC='\033[0m'
    RED='\033[0;31m'

    echo -e "${BLUE}→${NC} Downloading installer..."

    if ! curl -fsSL "$DOWNLOAD_URL" -o "$SELF_TEMP"; then
        echo -e "${RED}Error: Failed to download installer${NC}"
        rm -f "$SELF_TEMP"
        exit 1
    fi

    bash "$SELF_TEMP" --non-interactive "$@"
    EXIT_CODE=$?
    rm -f "$SELF_TEMP"
    exit $EXIT_CODE
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

VERSION="1.1.1"
INSTALL_DIR="$HOME/.shipnode"

# Parse flags
NON_INTERACTIVE=false
for arg in "$@"; do
    if [ "$arg" = "--non-interactive" ]; then
        NON_INTERACTIVE=true
    fi
done

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

# Get absolute path of this script (after pipe detection, $0 is always a real file)
if command -v readlink &> /dev/null && readlink -f "$0" &> /dev/null; then
    # Linux: use readlink -f
    SCRIPT_PATH="$(readlink -f "$0")"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS: readlink -f doesn't exist, construct absolute path manually
    if [ -L "$0" ]; then
        SCRIPT_PATH="$(cd "$(dirname "$0")" && cd "$(dirname "$(readlink "$0")")" && pwd)/$(basename "$(readlink "$0")")"
    else
        SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
    fi
else
    # Fallback
    SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
fi

# Create temp directory
TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"

# Extract the base64-encoded tar.gz from this script
ARCHIVE_LINE=$(awk '/^__ARCHIVE_BELOW__/ {print NR + 1; exit 0; }' "$SCRIPT_PATH")
tail -n +${ARCHIVE_LINE} "$SCRIPT_PATH" | base64 -d | tar -xz

# Check extraction
if [ ! -d "shipnode" ]; then
    echo -e "${RED}Error: Extraction failed${NC}"
    exit 1
fi

echo -e "${GREEN}✓${NC} Extracted successfully"

# Choose installation location
# If not interactive (e.g., piped from curl or --non-interactive flag), default to recommended location
if [ "$NON_INTERACTIVE" = true ] || [ ! -t 0 ]; then
    INSTALL_DIR="$HOME/.shipnode"
    USE_SUDO=""
    echo -e "${BLUE}→${NC} Non-interactive mode: installing to $INSTALL_DIR"
else
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
fi

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
SHIPNODE_BIN="$INSTALL_DIR/shipnode"
EXPORT_LINE="export PATH=\"$INSTALL_DIR:\$PATH\""
ADDED_TO=""

if [ -f ~/.bashrc ]; then
    if ! grep -q "$INSTALL_DIR" ~/.bashrc 2>/dev/null; then
        echo "" >> ~/.bashrc
        echo "# ShipNode" >> ~/.bashrc
        echo "$EXPORT_LINE" >> ~/.bashrc
        ADDED_TO="~/.bashrc"
    fi
fi

if [ -f ~/.zshrc ]; then
    if ! grep -q "$INSTALL_DIR" ~/.zshrc 2>/dev/null; then
        echo "" >> ~/.zshrc
        echo "# ShipNode" >> ~/.zshrc
        echo "$EXPORT_LINE" >> ~/.zshrc
        [ -n "$ADDED_TO" ] && ADDED_TO="$ADDED_TO and ~/.zshrc" || ADDED_TO="~/.zshrc"
    fi
fi

if [ -n "$ADDED_TO" ]; then
    echo -e "${GREEN}✓${NC} Added to PATH in $ADDED_TO"
    echo -e "  Restart your terminal or run: ${BLUE}source $ADDED_TO${NC}"
else
    echo -e "${YELLOW}⚠${NC} Already in PATH or no shell config found"
fi

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
}
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

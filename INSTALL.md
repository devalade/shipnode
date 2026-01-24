# ShipNode Installation Guide

## Quick Install (Recommended)

Download and run the self-extracting installer:

```bash
curl -fsSL https://github.com/devalade/shipnode/releases/latest/download/shipnode-installer.sh | bash
```

Or download manually:

```bash
wget https://github.com/devalade/shipnode/releases/latest/download/shipnode-installer.sh
chmod +x shipnode-installer.sh
./shipnode-installer.sh
```

The interactive installer will:
- Extract ShipNode to your chosen location
- Automatically set up PATH or create a symlink
- Verify the installation

## Alternative: Install from Source

If you prefer to install from source:

```bash
git clone https://github.com/devalade/shipnode.git
cd shipnode
./install.sh
```

## Installation Options

The installer offers several installation locations and PATH setup methods:

### Installation Locations

1. **~/.shipnode** (Default) - No sudo required, recommended for single users
2. **/opt/shipnode** (System-wide) - Requires sudo, for multi-user systems
3. **Custom path** - Specify your own location

### PATH Setup Methods

#### Option 1: Symlink to /usr/local/bin (Recommended)

Creates a system-wide symlink. Requires sudo. `shipnode` will be available globally from any directory.

**Pros:**
- Works in all shells (bash, zsh, fish, etc.)
- No shell config modifications needed
- Clean and standard approach

**Cons:**
- Requires sudo access

#### Option 2: Add to ~/.bashrc

Adds ShipNode to your PATH in bash configuration. After installation, run `source ~/.bashrc` or restart your terminal.

**Pros:**
- No sudo required
- Easy to modify or remove

**Cons:**
- Only works in bash
- Requires sourcing config after install

#### Option 3: Add to ~/.zshrc

Same as option 2, but for zsh users. After installation, run `source ~/.zshrc` or restart your terminal.

#### Option 4: Add to both bash and zsh

If you use both shells or are unsure which one you use.

#### Option 5: Manual Setup

Skip automatic installation and set up manually. The installer will show you the commands to run manually.

## Verification

After installation, verify ShipNode is available:

```bash
shipnode help
```

You should see the ShipNode help menu.

## Troubleshooting

### "command not found: shipnode"

**After symlink installation:**
- Check if /usr/local/bin is in your PATH:
  ```bash
  echo $PATH | grep /usr/local/bin
  ```
- If not, add it to your shell config:
  ```bash
  export PATH="/usr/local/bin:$PATH"
  ```

**After PATH installation:**
- Make sure you sourced your shell config:
  ```bash
  source ~/.bashrc  # or ~/.zshrc
  ```
- Or restart your terminal

### "Permission denied"

Make sure the script is executable:
```bash
chmod +x ~/Code/Labs/shipnode/install.sh
```

### "Already in ~/.bashrc" or "Already in ~/.zshrc"

The installer detected an existing ShipNode entry in your config. This is safe to ignore.

## Building the Installer

If you want to build the self-extracting installer yourself:

```bash
git clone https://github.com/devalade/shipnode.git
cd shipnode
make build
```

This creates `dist/shipnode-installer.sh`.

## Uninstallation

To remove ShipNode:

1. **Remove installation directory:**
   ```bash
   rm -rf ~/.shipnode  # or /opt/shipnode, or your custom path
   ```

2. **Remove symlink (if created):**
   ```bash
   sudo rm /usr/local/bin/shipnode
   ```

3. **Remove from shell config (if added to PATH):**
   Edit `~/.bashrc` or `~/.zshrc` and remove the ShipNode export lines.

Or if installed from source:
```bash
cd /path/to/shipnode
./uninstall.sh
```

## Next Steps

After installation:

1. **Read the documentation**
   ```bash
   cat ~/Code/Labs/shipnode/README.md
   ```

2. **Initialize a project**
   ```bash
   cd /path/to/your/project
   shipnode init
   ```

3. **Deploy**
   ```bash
   shipnode deploy
   ```

## Updating

To update to the latest version, simply download and run the installer again:

```bash
curl -fsSL https://github.com/devalade/shipnode/releases/latest/download/shipnode-installer.sh | bash
```

## Support

If you encounter issues:
1. Check the [README.md](README.md)
2. Report issues: https://github.com/devalade/shipnode/issues
3. Check installation: `which shipnode` and `shipnode help`

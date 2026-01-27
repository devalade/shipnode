# ShipNode

Simple, zero-config deployment tool for Node.js backends and static frontends. Deploy **one app at a time** with a single command.

## Features

- **Single CLI tool** for both backend and frontend deployments
- **Enhanced interactive UI** powered by [Gum](https://github.com/charmbracelet/gum) (automatically installed) ✨
- **Zero-downtime deployments** with atomic release switching
- **Automatic rollback** on health check failure
- **Release management** with configurable retention
- **Health checks** for backend deployments
- **Zero dependencies** (pure bash script)
- **PM2** process management for backends
- **Caddy** web server with automatic HTTPS
- **One-command deployment** with rsync
- **Simple configuration** via `shipnode.conf`

## Installation

### Quick Install (Recommended)

Download and run the self-extracting installer:

```bash
curl -fsSL https://github.com/devalade/shipnode/releases/latest/download/shipnode-installer.sh | bash
```

Or download manually first:

```bash
wget https://github.com/devalade/shipnode/releases/latest/download/shipnode-installer.sh
chmod +x shipnode-installer.sh
./shipnode-installer.sh
```

The installer will:
- Extract ShipNode to your chosen location (~/.shipnode, /opt/shipnode, or custom)
- Create a symlink to `/usr/local/bin` or add to your PATH
- Verify the installation

### Install from Source

```bash
git clone https://github.com/devalade/shipnode.git
cd shipnode
./install.sh
```

### Uninstall

```bash
# If installed via installer
rm -rf ~/.shipnode  # or /opt/shipnode
sudo rm /usr/local/bin/shipnode

# If installed from source
cd /path/to/shipnode
./uninstall.sh
```

See [INSTALL.md](INSTALL.md) for detailed installation instructions.

## What's New in v1.1.0

ShipNode now supports **zero-downtime deployments** with automatic health checks and rollback capabilities! See [CHANGELOG.md](CHANGELOG.md) for full release notes.

Key features:
- Atomic release-based deployments
- Automatic health check validation
- One-command rollback to previous releases
- Deployment lock to prevent concurrent deploys
- Configurable release retention

## Quick Start

### 1. Initialize Project

In your project directory:

```bash
cd /path/to/your/project
shipnode init
```

The **interactive wizard** will guide you through configuration:

- Auto-detects your framework (Express, NestJS, React, Next.js, etc.)
- Suggests smart defaults based on your `package.json`
- Validates all inputs in real-time
- Shows configuration summary before creating files

**Example output:**
```
╔════════════════════════════════════╗
║  ShipNode Interactive Setup        ║
╚════════════════════════════════════╝

→ Detected framework: Express
→ Suggested app type: backend

Application type:
  1) Backend (Node.js API with PM2)
  2) Frontend (Static site)

Choose [1-2] (detected: backend): 
SSH user [root]: 
SSH host (IP or hostname): 203.0.113.10
SSH port [22]: 
Remote deployment path [/var/www/myapp]: 
PM2 process name [myapp]: 
Application port [3000]: 
Domain (optional, press Enter to skip): api.myapp.com

════════════════════════════════════
Configuration Summary
════════════════════════════════════
App Type:      backend
SSH:           root@203.0.113.10:22
Remote Path:   /var/www/myapp
PM2 Name:      myapp
Backend Port:  3000
Domain:        api.myapp.com
Zero-downtime: true
Health Checks: /health (30s timeout, 3 retries)
════════════════════════════════════

Create shipnode.conf with these settings? (Y/n): 
```

**For CI/CD or scripts** (non-interactive mode):
```bash
shipnode init --non-interactive
```

This creates `shipnode.conf` with default settings that you can edit manually.

### 2. Configure (if needed)

The wizard creates an optimized `shipnode.conf`. Only edit manually if using `--non-interactive`:

```bash
# Example backend configuration
APP_TYPE=backend
SSH_USER=root
SSH_HOST=123.45.67.89
REMOTE_PATH=/var/www/myapp
PM2_APP_NAME=myapp
BACKEND_PORT=3000
DOMAIN=api.myapp.com  # optional

# Example frontend configuration
APP_TYPE=frontend
SSH_USER=root
SSH_HOST=123.45.67.89
REMOTE_PATH=/var/www/myapp
DOMAIN=myapp.com
```

### 3. Setup Server (First Time)

```bash
shipnode setup
```

This installs Node.js, PM2, and Caddy on your server.

### 4. Deploy

```bash
shipnode deploy
```

That's it! Your app is live.

## Commands

```bash
# Deployment
shipnode init                # Create shipnode.conf
shipnode setup               # Setup server (first time only)
shipnode deploy              # Deploy app
shipnode deploy --skip-build # Deploy without building
shipnode status              # Check app status
shipnode logs                # View logs (backend only)
shipnode restart             # Restart app (backend only)
shipnode stop                # Stop app (backend only)
shipnode rollback            # Rollback to previous release
shipnode rollback 2          # Rollback 2 releases back
shipnode releases            # List all available releases
shipnode migrate             # Migrate to release structure

# User Management
shipnode user sync           # Provision users from users.yml
shipnode user list           # List all provisioned users
shipnode user remove <user>  # Revoke access for a user
shipnode mkpasswd            # Generate password hash
```

## Zero-Downtime Deployment

## Troubleshooting

### Gum installation fails
- Symptom: "Failed to install Gum. The interactive wizard will use fallback mode."
- Cause: Package not available on your distro or missing sudo privileges
- Fix:
  - Install manually: Debian/Ubuntu `sudo apt install gum`, Fedora `sudo dnf install gum`, Arch `sudo pacman -S gum`, Alpine `sudo apk add gum`, macOS `brew install gum`
  - Check installation log: `/tmp/shipnode_gum_install_<PID>.log`
  - Continue without Gum: the wizard will automatically use classic prompts

### Framework not detected
- Ensure `package.json` is valid JSON (no trailing commas)
- `jq` must be available on your local machine
  - Install: `sudo apt install jq` or equivalent
- The wizard still works without detection; select app type manually

### Port not detected
- The wizard supports common patterns: `PORT=3000`, `--port=5000`, `localhost:4000`, `listen(:3000)`
- If your scripts differ, enter the port manually when prompted

### CI/CD environments
- Non-interactive environments have no TTY; Gum prompts are auto-disabled
- Use `shipnode init --non-interactive` for fully scripted setups

### SSH issues
- Test connection: `ssh -p <port> <user>@<host>`
- Ensure public key is deployed or correct password authentication is enabled
- Verify firewall allows SSH port

ShipNode uses atomic release-based deployments to ensure zero downtime during updates.

### How It Works

Each deployment creates a timestamped release in the `releases/` directory:

```
/var/www/myapp/
├── releases/
│   ├── 20240124150000/     # Previous release
│   ├── 20240124160000/     # Current release
│   └── 20240124170000/     # Latest release
├── current -> releases/20240124170000/  # Atomic symlink
├── shared/
│   ├── .env                # Shared environment variables
│   └── logs/               # Shared logs
└── .shipnode/
    ├── releases.json       # Release history
    └── deploy.lock         # Deployment lock
```

During deployment:
1. New release created in `releases/$timestamp/`
2. Dependencies installed per-release
3. Symlink atomically switched: `current -> releases/$timestamp/`
4. PM2 reloaded (backend only)
5. Health check performed
6. If health check fails → automatic rollback
7. Old releases cleaned up (keeps last N releases)

### Configuration

Add to `shipnode.conf`:

```bash
# Enable zero-downtime deployment (enabled by default)
ZERO_DOWNTIME=true

# Number of releases to keep (default: 5)
KEEP_RELEASES=5

# Health check settings (backend only)
HEALTH_CHECK_ENABLED=true
HEALTH_CHECK_PATH=/health        # Endpoint to check
HEALTH_CHECK_TIMEOUT=30          # Seconds per attempt
HEALTH_CHECK_RETRIES=3           # Attempts before rollback
```

### Health Checks

For backend deployments, add a health endpoint to your app:

```javascript
// Express example
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Fastify example
fastify.get('/health', async (request, reply) => {
  return { status: 'ok' };
});
```

After deployment, ShipNode will:
- Wait 3 seconds for app to start
- Attempt health check (default: 3 retries, 30s timeout)
- If all checks fail → automatic rollback to previous release
- If checks pass → deployment succeeds

### Rollback

Rollback to a previous release:

```bash
# Rollback to immediately previous release
shipnode rollback

# Rollback 2 releases back
shipnode rollback 2

# List available releases first
shipnode releases
```

Rollback performs:
1. Atomic symlink switch to target release
2. PM2 reload (backend only)
3. Health check verification
4. Confirmation of success/failure

### Migration

If you have an existing deployment, migrate to the release structure:

```bash
shipnode migrate
```

This will:
1. Move existing files to first release
2. Create release structure
3. Setup `current` symlink
4. Update PM2 configuration (backend)
5. Update Caddy configuration

**Note:** Migration is a one-time operation. Back up your data first.

### Disabling Zero-Downtime

To use legacy deployment (direct rsync without releases):

```bash
# In shipnode.conf
ZERO_DOWNTIME=false
```

### Example Workflow

```bash
# Initial deployment
shipnode deploy
# → Creates releases/20240124150000/, sets as current

# Deploy update
shipnode deploy
# → Creates releases/20240124160000/
# → Runs health check
# → If success: switches to new release
# → If failure: auto-rollback to 20240124150000/

# Check releases
shipnode releases
# → Shows all releases with current marker

# Manual rollback if needed
shipnode rollback
# → Switches back to previous release

# Rollback to specific older release
shipnode rollback 3
# → Goes back 3 releases
```

## User Provisioning

ShipNode allows you to provision multiple users on your server with SSH or password authentication. Users can be granted deployment permissions and optional sudo access.

### Quick Start

1. **Generate password hash:**
```bash
shipnode mkpasswd
# Enter password: ********
# Output: $6$rounds=5000$salt$hash...
```

2. **Create `users.yml`:**
```bash
cp users.yml.example users.yml
```

3. **Edit `users.yml` with your users:**
```yaml
users:
  - username: alice
    email: alice@example.com
    password: "$6$rounds=5000$..."  # From mkpasswd

  - username: bob
    email: bob@example.com
    authorized_key: "ssh-ed25519 AAAAC3... bob@laptop"
    sudo: true
```

4. **Sync users to server:**
```bash
shipnode user sync
```

### Configuration File

The `users.yml` file defines all users to provision. Place it in the same directory as `shipnode.conf`.

#### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `username` | string | Yes | System username (alphanumeric + underscore/dash, max 32 chars) |
| `email` | string | Yes | User email address |
| `password` | string | No | Hashed password (use `shipnode mkpasswd`) |
| `sudo` | boolean | No | Grant sudo access (default: false) |
| `authorized_key` | string | No | Single SSH public key (inline) |
| `authorized_key_file` | string | No | Path to SSH public key file |
| `authorized_keys` | list | No | Multiple SSH public keys |

#### Example Configurations

**Password user (must change on first login):**
```yaml
- username: alice
  email: alice@company.com
  password: "$6$rounds=5000$saltsalt$hashedpassword..."
```

**SSH key user with sudo:**
```yaml
- username: bob
  email: bob@company.com
  authorized_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample... bob@laptop"
  sudo: true
```

**CI/CD user (key from file):**
```yaml
- username: ci-deploy
  email: ci@company.com
  authorized_key_file: ~/.ssh/ci_deploy.pub
```

**User with multiple keys:**
```yaml
- username: developer
  email: dev@company.com
  authorized_keys:
    - "ssh-ed25519 AAAAC3... dev@work"
    - "ssh-ed25519 AAAAC3... dev@home"
```

**Admin with password + SSH key + sudo:**
```yaml
- username: devops
  email: devops@company.com
  password: "$6$rounds=5000$..."
  sudo: true
  authorized_key: "ssh-ed25519 AAAAC3... devops@work"
```

### Commands

**Sync users to server:**
```bash
shipnode user sync
```
- Creates new users defined in `users.yml`
- Skips existing users (idempotent)
- Sets up SSH keys and permissions
- Forces password change on first login for password users

**List provisioned users:**
```bash
shipnode user list
```
Shows all users with their auth method, sudo status, and creation date.

**Remove user access:**
```bash
shipnode user remove alice
```
- Removes user from `shipnode-deployers` and `sudo` groups
- Locks account
- Clears SSH keys
- Does NOT delete the system user

**Generate password hash:**
```bash
shipnode mkpasswd
```
Prompts for password and generates hash for `users.yml`.

### How It Works

When you run `shipnode user sync`, ShipNode:

1. **Creates users** on the server with specified authentication
2. **Creates `shipnode-deployers` group** for deployment permissions
3. **Sets up ACLs** on deployment directory for group access
4. **Configures sudo** for PM2 commands (all deployers can manage PM2)
5. **Grants full sudo** to users with `sudo: true`
6. **Records users** in `.shipnode/users.json` on server

#### Authentication Methods

**Password Authentication:**
- User created with hashed password
- Forced to change password on first SSH login (`chage -d 0`)
- Generate hash with `shipnode mkpasswd`

**SSH Key Authentication:**
- Keys added to `~/.ssh/authorized_keys`
- Immediate access upon creation
- Can specify inline, from file, or multiple keys

### Permissions

All provisioned users are automatically added to the `shipnode-deployers` group with:

- **Read/write/execute** access to deployment directory
- **PM2 management** via sudo (no password required for `pm2` commands)
- **ACLs** set on deployment directory and inherited by new files

Users with `sudo: true` additionally get:
- **Full sudo access** (added to `sudo` group)

### Example Workflow

```bash
# 1. Generate password for a user
shipnode mkpasswd
# Enter password: ********
# $6$rounds=5000$...

# 2. Create users.yml
cat > users.yml << EOF
users:
  - username: alice
    email: alice@company.com
    password: "\$6\$rounds=5000\$..."

  - username: bob
    email: bob@company.com
    authorized_key: "ssh-ed25519 AAAAC3NzaC1lZDI1... bob@laptop"
    sudo: true

  - username: ci-deploy
    email: ci@company.com
    authorized_key_file: ~/.ssh/ci_deploy.pub
EOF

# 3. Provision users
shipnode user sync
# Created user: alice (password auth, must change on first login)
# Created user: bob (SSH key added, sudo enabled)
# Created user: ci-deploy (SSH key added)

# 4. List users
shipnode user list
# USERNAME    EMAIL                   AUTH        SUDO    CREATED
# alice       alice@company.com       password    no      2024-01-24
# bob         bob@company.com         ssh-key     yes     2024-01-24
# ci-deploy   ci@company.com          ssh-key     no      2024-01-24

# 5. Test deployment as provisioned user
# alice logs in and must change password
ssh alice@server
# Current password:
# New password:

# bob can deploy immediately
ssh bob@server
cd /var/www/myapp
git pull && npm install && pm2 reload myapp

# 6. Remove user when no longer needed
shipnode user remove bob
# Revoked access for: bob
```

### Security Notes

- **Password users** must change password on first login
- **SSH keys** provide immediate, passwordless access
- **Sudo access** should be granted sparingly
- **User removal** locks account but preserves system user
- All users can manage PM2 for deployment purposes
- Full deployment directory access via ACLs

### Troubleshooting

**"mkpasswd not found":**
```bash
sudo apt-get install whois
```

**"Invalid password hash":**
Ensure password is wrapped in quotes in `users.yml`:
```yaml
password: "$6$rounds=5000$..."  # Correct
password: $6$rounds=5000$...    # Wrong - shell will interpret $
```

**User can't access deployment directory:**
```bash
# Re-sync to fix permissions
shipnode user sync
```

**User can't use PM2:**
Check if sudoers file exists:
```bash
ssh root@server "cat /etc/sudoers.d/shipnode"
```

## Backend Deployment

For Node.js applications with PM2 process management.

### Requirements

- `package.json` in project root
- Main entry file (e.g., `index.js`, `server.js`, or as defined in `package.json`)
- `.env` file (excluded from sync, manage separately)

### What Happens

1. **Syncs files** via rsync (excludes `node_modules`, `.env`, `.git`)
2. **Installs dependencies** with `npm install --production`
3. **Starts/reloads** app with PM2
4. **Configures Caddy** reverse proxy (if DOMAIN is set)

### Example: Express API

```bash
# Project structure
myapi/
├── index.js
├── package.json
├── .env
└── shipnode.conf

# shipnode.conf
APP_TYPE=backend
SSH_USER=root
SSH_HOST=123.45.67.89
REMOTE_PATH=/var/www/myapi
PM2_APP_NAME=myapi
BACKEND_PORT=3000
DOMAIN=api.myapp.com

# Deploy
shipnode deploy
```

Your API is now running at `https://api.myapp.com` with PM2 managing the process.

### Managing Backend

```bash
shipnode status    # Check if app is running
shipnode logs      # Stream live logs
shipnode restart   # Restart app (zero downtime)
shipnode stop      # Stop app
```

## Frontend Deployment

For static sites (React, Vue, Svelte, etc.) or pre-built HTML/CSS/JS.

### What Happens

1. **Builds locally** (runs `npm run build` if `package.json` exists)
2. **Syncs build output** to server (default: `dist/`, auto-detects `build/` or `public/`)
3. **Configures Caddy** to serve static files (if DOMAIN is set)

### Example: React App

```bash
# Project structure
myapp/
├── src/
├── dist/           # build output
├── package.json
└── shipnode.conf

# shipnode.conf
APP_TYPE=frontend
SSH_USER=root
SSH_HOST=123.45.67.89
REMOTE_PATH=/var/www/myapp
DOMAIN=myapp.com

# Deploy
shipnode deploy
```

Your site is now live at `https://myapp.com` with automatic HTTPS from Caddy.

### Skip Build

If you've already built locally or want to deploy pre-built files:

```bash
shipnode deploy --skip-build
```

## Configuration

### Complete `shipnode.conf` Reference

```bash
# Required
APP_TYPE=backend           # "backend" or "frontend"
SSH_USER=root             # SSH user
SSH_HOST=123.45.67.89     # Server IP or hostname
REMOTE_PATH=/var/www/app  # Deployment path on server

# Optional
SSH_PORT=22               # SSH port (default: 22)

# Backend-specific (required if APP_TYPE=backend)
PM2_APP_NAME=myapp        # PM2 process name
BACKEND_PORT=3000         # App listening port

# Optional for both
DOMAIN=myapp.com          # Domain for Caddy config

# Zero-downtime deployment
ZERO_DOWNTIME=true              # Enable atomic deployments (default: true)
KEEP_RELEASES=5                 # Releases to keep (default: 5)
HEALTH_CHECK_ENABLED=true       # Enable health checks (default: true)
HEALTH_CHECK_PATH=/health       # Health endpoint (default: /health)
HEALTH_CHECK_TIMEOUT=30         # Timeout seconds (default: 30)
HEALTH_CHECK_RETRIES=3          # Retry count (default: 3)
```

## Server Requirements

- Ubuntu/Debian server (18.04+)
- Root or sudo access
- SSH access with password or key

ShipNode installs these automatically with `shipnode setup`:
- Node.js (LTS version)
- PM2 (for backend apps)
- Caddy (web server with auto-HTTPS)

## Templates

Use these templates to customize your deployments:

- `templates/ecosystem.config.js.template` - PM2 configuration
- `templates/Caddyfile.backend.template` - Backend reverse proxy
- `templates/Caddyfile.frontend.template` - Frontend static server

Copy to your project and customize as needed.

## SSH Keys

For passwordless deployment, add your SSH key to the server:

```bash
ssh-copy-id -p 22 root@your-server-ip
```

## Troubleshooting

### "Cannot connect to server"

Check SSH connection manually:
```bash
ssh -p 22 root@your-server-ip
```

### "PM2 not found"

Run setup again:
```bash
shipnode setup
```

### "Build failed"

Check your build command in `package.json`:
```json
{
  "scripts": {
    "build": "vite build"  // or your build command
  }
}
```

### "Port already in use"

Change `BACKEND_PORT` in `shipnode.conf` or stop the conflicting process:
```bash
ssh root@your-server "lsof -ti:3000 | xargs kill"
```

### Backend not starting

Check PM2 logs:
```bash
shipnode logs
```

Or SSH to server and check:
```bash
ssh root@your-server
pm2 logs myapp
pm2 status
```

### Caddy not serving HTTPS

Ensure:
1. Domain DNS points to server IP
2. Ports 80 and 443 are open
3. Check Caddy logs: `ssh root@server "journalctl -u caddy -n 50"`

### Health check failures

If deployments keep failing health checks:

1. Verify your app has the health endpoint:
   ```bash
   ssh root@your-server "curl http://localhost:3000/health"
   ```

2. Check if health check path is correct in `shipnode.conf`
3. Increase timeout: `HEALTH_CHECK_TIMEOUT=60`
4. Check PM2 logs: `shipnode logs`
5. Temporarily disable: `HEALTH_CHECK_ENABLED=false`

### Deployment lock issues

If you see "Another deployment in progress":

```bash
# Check for stale lock (SSH to server)
ssh root@your-server "cat /var/www/myapp/.shipnode/deploy.lock"
ssh root@your-server "rm /var/www/myapp/.shipnode/deploy.lock"
```

### Release cleanup

Manually clean old releases:

```bash
ssh root@your-server "cd /var/www/myapp/releases && ls -t | tail -n +6 | xargs rm -rf"
```

Or adjust retention: `KEEP_RELEASES=10` in `shipnode.conf`

## Comparison with Other Tools

| Feature | ShipNode | Deployer | PM2 Deploy | Capistrano |
|---------|----------|----------|------------|------------|
| Language | Bash | PHP | JS | Ruby |
| Config | 1 file | Multiple | ecosystem.config.js | Multiple |
| Learning curve | Minutes | Hours | Hours | Days |
| Dependencies | None | PHP | Node.js | Ruby |
| Caddy integration | ✅ | ❌ | ❌ | ❌ |
| Frontend + Backend | ✅ | ❌ | ✅ | ✅ |

## Examples

### Backend API + Frontend SPA

Deploy them separately with different configs:

```bash
# Backend
cd ~/projects/api
shipnode init
# Edit shipnode.conf (APP_TYPE=backend, DOMAIN=api.myapp.com)
shipnode deploy

# Frontend
cd ~/projects/web
shipnode init
# Edit shipnode.conf (APP_TYPE=frontend, DOMAIN=myapp.com)
shipnode deploy
```

### Multiple Environments

Use different config files:

```bash
# Production
shipnode deploy  # uses shipnode.conf

# Staging (copy config first)
cp shipnode.conf shipnode.staging.conf
# Edit shipnode.staging.conf
# Note: You'll need to modify the script to support this use case
```

## Advanced Usage

### Custom Build Directory

If your build output is in a non-standard location, create a symlink:

```bash
ln -s my-custom-dist dist
```

### Environment Variables

For backends, manage `.env` files separately:

**With zero-downtime deployment:**
```bash
# Copy .env to shared directory (persists across releases)
scp .env root@your-server:/var/www/myapp/shared/.env

# Then deploy (will be symlinked to each release)
shipnode deploy
```

**Without zero-downtime deployment:**
```bash
# Copy .env directly
scp .env root@your-server:/var/www/myapp/.env

# Then deploy
shipnode deploy
```

### Custom PM2 Config

Copy the template and customize:

```bash
cp ~/Code/Labs/shipnode/templates/ecosystem.config.js.template ./ecosystem.config.js
# Edit ecosystem.config.js
# Deploy will use your custom config
```

### Multiple Instances

Edit `ecosystem.config.js`:

```javascript
instances: 4,  // or 'max' for all CPU cores
exec_mode: 'cluster'
```

## Security Notes

- ShipNode doesn't handle secrets - manage `.env` files manually
- Use SSH keys instead of passwords
- Run as non-root user when possible
- Enable UFW firewall: `ufw allow 22,80,443/tcp`
- Keep server updated: `apt update && apt upgrade`

## Roadmap

Upcoming features to make deployment even simpler:

### Interactive `init` Wizard
Auto-detect framework and guide setup with prompts:
```bash
$ shipnode init
Detected: package.json with "express" dependency → backend

? Server IP: 192.168.1.100
? SSH user [root]: deploy
? Domain: api.myapp.com
? Add deployment users? (Y/n): y
? Username: alice
? Email: alice@company.com
? Auth method: (ssh-key/password) ssh-key
? SSH public key: ssh-ed25519 AAAAC3...

✓ Created shipnode.conf
✓ Created users.yml (1 user)
```

### Pre-flight Checks (`doctor`)
Validate everything before deployment:
```bash
$ shipnode doctor
✓ shipnode.conf exists
✓ SSH connection OK
✓ Node.js v20 installed
✗ Health endpoint /health not responding
```

### GitHub Actions Generator
Auto-generate CI/CD workflow:
```bash
$ shipnode ci github
✓ Created .github/workflows/deploy.yml

Required secrets: SSH_PRIVATE_KEY, SSH_HOST
```

## Contributing

ShipNode is a simple tool intentionally. If you need:
- Blue-green deployments → Use Kubernetes
- Complex rollbacks → Use Capistrano
- CI/CD integration → Use GitHub Actions + ShipNode

But if you find bugs or have simple improvements, contributions welcome!

## License

MIT

## Author

Created for simple, no-nonsense Node.js deployments.

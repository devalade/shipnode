# ShipNode

Simple, zero-config deployment tool for Node.js backends and static frontends. Deploy **one app at a time** with a single command.

## Features

- **Single CLI tool** for both backend and frontend deployments
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

This creates `shipnode.conf` with default settings.

### 2. Configure

Edit `shipnode.conf`:

```bash
# For a backend app
APP_TYPE=backend
SSH_USER=root
SSH_HOST=123.45.67.89
REMOTE_PATH=/var/www/myapp
PM2_APP_NAME=myapp
BACKEND_PORT=3000
DOMAIN=api.myapp.com  # optional

# For a frontend app
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
```

## Zero-Downtime Deployment

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

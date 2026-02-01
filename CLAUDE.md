# ShipNode - Claude Context

Zero-downtime deployment tool for Node.js applications. Modular bash CLI for deploying backend/frontend apps with PM2, Caddy, PostgreSQL support.

## Quick Commands

### Build/Test/Lint
```bash
make build          # Build distributable installer
make test           # Test installer
make install        # Install locally from source
make clean          # Remove dist/
bash -n <file>      # Syntax check bash file
shellcheck <file>   # Lint bash file
```

### Development
```bash
./shipnode <cmd>    # Run from source
```

## Architecture

### Entry Point Flow
```
shipnode (main entry)
  ↓
  sources lib/*.sh modules (core, release, database, users, framework, validation, prompts, pkg-manager, templates)
  ↓
  sources lib/commands/*.sh (config, init, setup, deploy, status, etc.)
  ↓
  calls main() from commands/main.sh
  ↓
  dispatches to cmd_<name>() via case statement
```

### Module System
- **Modular bash**: 21 focused modules, single responsibility
- **Load order**: core → helpers → commands → main dispatcher
- **No side effects**: modules define functions only, no execution on source
- **Entry point**: `shipnode` sources all modules then calls `main()`

### Core Modules (lib/)
- **core.sh**: Globals, colors, logging (error/success/info/warn), OS detection, Gum install
- **release.sh**: Zero-downtime deploy (timestamps, symlinks, health checks, rollback)
- **database.sh**: PostgreSQL setup
- **users.sh**: User provisioning (creation, SSH keys, permissions, sudo, revocation)
- **framework.sh**: Framework detection from package.json (Express, NestJS, Next.js, React, etc.)
- **validation.sh**: Input validation (IP, port, domain, SSH, remote port checks)
- **prompts.sh**: Interactive prompts with Gum UI fallback
- **pkg-manager.sh**: Package manager detection (npm/yarn/pnpm/bun) from lockfiles, installation on remote server
- **templates.sh**: Framework templates for init

### Command Modules (lib/commands/)
- **config.sh**: `load_config()` - sources shipnode.conf
- **main.sh**: `main()` - command dispatcher (case statement)
- **init.sh**: `cmd_init()` - interactive/legacy project setup
- **setup.sh**: `cmd_setup()` - first-time server setup (Node, PM2, Caddy, jq, package manager)
- **deploy.sh**: `cmd_deploy()` - backend/frontend deployment (legacy/zero-downtime)
- **status.sh**: `cmd_status/logs/restart/stop()` - app management
- **rollback.sh**: `cmd_rollback/releases()` - release management
- **migrate.sh**: `cmd_migrate()` - migrate to release structure
- **env.sh**: `cmd_env()` - upload .env
- **user.sh**: `cmd_user_sync/list/remove()` - user management
- **users-yaml.sh**: `init_users_yaml()` - generate users.yml
- **mkpasswd.sh**: `cmd_mkpasswd()` - password hash generation
- **doctor.sh**: `cmd_doctor()` - health diagnostics
- **help.sh**: `cmd_help()` - help text
- **unlock.sh**: `cmd_unlock()` - clear deploy lock

## Key Patterns

### Command Functions
```bash
cmd_mycommand() {
    load_config  # Load shipnode.conf
    # Implementation
}
```

### Configuration Loading
```bash
load_config() {
    [ -f shipnode.conf ] || error "No shipnode.conf found"
    source shipnode.conf
    # Validates required vars
}
```

### SSH Execution Pattern
```bash
ssh "$SSH_USER@$SSH_HOST" -p "$SSH_PORT" << 'EOF'
    # Remote commands here
    # Heredoc ensures no local expansion
EOF
```

### Gum UI Fallback
```bash
gum_input "Prompt" "default"      # Falls back to read -p
gum_choose "opt1" "opt2"          # Falls back to select
gum_confirm "Question?"           # Falls back to read -p
gum_style --foreground "text"     # Falls back to echo
```

### Package Manager Detection
```bash
PKG_MANAGER=$(detect_pkg_manager)  # Checks PKG_MANAGER override or lockfiles
INSTALL_CMD=$(get_pkg_install_cmd "$PKG_MANAGER")
RUN_CMD=$(get_pkg_run_cmd "$PKG_MANAGER" "build")
START_CMD=$(get_pkg_start_cmd "$PKG_MANAGER" "$PM2_APP_NAME")
```

## Adding New Commands

1. Create `lib/commands/mycommand.sh`:
```bash
cmd_mycommand() {
    load_config
    # Implementation
}
```

2. Add case in `lib/commands/main.sh`:
```bash
case "${1:-}" in
    mycommand)
        cmd_mycommand "$@"
        ;;
esac
```

3. Update `lib/commands/help.sh`:
```bash
echo "    mycommand         Description"
```

4. Update README.md with docs
5. Update ARCHITECTURE.md dependencies if needed

## Configuration (shipnode.conf)

Sourced as bash, key variables:

### Required
- `APP_TYPE`: "backend" | "frontend"
- `SSH_USER`, `SSH_HOST`, `SSH_PORT`: SSH connection
- `REMOTE_PATH`: Deploy path on server

### Backend-specific
- `PM2_APP_NAME`: PM2 process name
- `BACKEND_PORT`: App port

### Frontend-specific
- `DOMAIN`: Caddy domain (optional)
- `BUILD_DIR`: Build output (auto-detected: dist/build/public)

### Node.js
- `NODE_VERSION`: Node major version ("lts", "20", "22", etc.)

### Package Manager
- `PKG_MANAGER`: Override detection ("npm"|"yarn"|"pnpm"|"bun")

### Zero-downtime
- `ZERO_DOWNTIME`: true/false
- `KEEP_RELEASES`: Number of releases to keep (default 5)
- `HEALTH_CHECK_ENABLED`: true/false
- `HEALTH_CHECK_PATH`: Endpoint (default /health)
- `HEALTH_CHECK_TIMEOUT`: Seconds (default 30)
- `HEALTH_CHECK_RETRIES`: Retries before rollback (default 3)

### Database
- `DB_SETUP_ENABLED`: true/false
- `DB_NAME`, `DB_USER`, `DB_PASSWORD`: PostgreSQL config

## Package Manager Detection & Installation

### Detection Flow
1. Check `PKG_MANAGER` in shipnode.conf
2. Validate override (npm/yarn/pnpm/bun)
3. If invalid/unset, detect from lockfiles:
   - bun.lockb → bun
   - pnpm-lock.yaml → pnpm
   - yarn.lock → yarn
   - default → npm
4. Generate commands:
   - Install: `bun install` | `pnpm install` | `yarn install` | `npm install`
   - Run: `<pm> run <script>`
   - PM2: `pm2 start bun -- start` | `pm2 start npm -- start` | etc.

### Installation During Setup
- `shipnode setup` detects package manager from local lockfiles
- Automatically installs yarn/pnpm/bun on remote server if needed
- npm comes with Node.js, no separate installation required
- Installation methods:
  - **yarn**: `npm install -g yarn`
  - **pnpm**: `npm install -g pnpm`
  - **bun**: `curl -fsSL https://bun.sh/install | bash`

## Zero-Downtime Deployment Model

### Structure
```
/var/www/myapp/
├── releases/
│   ├── 20250129_120000/   # Timestamped releases
│   ├── 20250129_130000/
│   └── 20250129_140000/
├── current -> releases/20250129_140000/  # Atomic symlink
├── shared/
│   └── .env               # Shared across releases
└── .deploy.lock           # Prevents concurrent deploys
```

### Flow
1. **Lock**: Acquire `.deploy.lock` (prevents concurrent deploys)
2. **Create release**: Generate timestamp, create `releases/<timestamp>/`
3. **Deploy code**: rsync/scp to release dir
4. **Install deps**: Run package manager install in release dir
5. **Build** (if needed): Run build command
6. **Link shared**: Symlink `shared/.env` to release
7. **Health check** (backend): Test `HEALTH_CHECK_PATH` endpoint
8. **Switch**: Atomic `ln -sfn` to update `current` symlink
9. **Reload**: Restart PM2/Caddy pointing to `current/`
10. **Record**: Log release in `.releases` history
11. **Cleanup**: Remove old releases (keep `KEEP_RELEASES`)
12. **Unlock**: Release `.deploy.lock`

### Rollback
- `shipnode rollback` → switches `current` to previous release
- `shipnode rollback <timestamp>` → switches to specific release
- No re-deploy needed, just symlink switch + reload

### Health Checks
- Backend only: HTTP GET to `http://localhost:$BACKEND_PORT$HEALTH_CHECK_PATH`
- Retries `HEALTH_CHECK_RETRIES` times with `HEALTH_CHECK_TIMEOUT` per attempt
- Fails → automatic rollback to previous release

## Testing Modules

Test in isolation:
```bash
source lib/core.sh
source lib/validation.sh

validate_port "3000" && echo "Valid"
validate_port "70000" || echo "Invalid"
```

## Common Patterns

### Logging
```bash
info "Deploying app..."
success "Deploy complete"
warn "No .env found"
error "Connection failed"  # Exits with code 1
```

### Validation
```bash
validate_ip_or_hostname "$SSH_HOST" || error "Invalid host"
validate_port "$BACKEND_PORT" || error "Invalid port"
test_ssh_connection || error "SSH failed"
```

### Remote Execution
```bash
# Simple command
ssh "$SSH_USER@$SSH_HOST" -p "$SSH_PORT" "pm2 restart $PM2_APP_NAME"

# Multi-line with variables
ssh "$SSH_USER@$SSH_HOST" -p "$SSH_PORT" << EOF
    cd $REMOTE_PATH/current
    pm2 restart $PM2_APP_NAME
EOF

# Escaped heredoc (no variable expansion)
ssh "$SSH_USER@$SSH_HOST" -p "$SSH_PORT" << 'EOF'
    echo "Literal \$VARIABLE"
EOF
```

## Framework Detection

Reads package.json dependencies to suggest:
- **Backend**: Express, NestJS, Fastify, Koa, Hapi, Hono, AdonisJS
- **Full-stack**: Next.js, Nuxt, Remix, Astro
- **Frontend**: React, Vue, Svelte, SolidJS, Angular

Auto-detects port from package.json scripts.

## Build System

`./build-dist.sh` concatenates modules into single `dist/shipnode-installer.sh` for distribution.

## Best Practices

1. **Single responsibility**: Each module does one thing
2. **Minimal deps**: Keep module coupling low
3. **No side effects**: Functions only, no execution on source
4. **Naming**: `cmd_<name>()` for commands, descriptive for helpers
5. **Error handling**: `error()` for fatal, `warn()` for non-fatal
6. **Comments**: Complex logic only, code should be self-documenting
7. **Search before implementing**: Before writing any new function, search the entire codebase with Grep to check if it already exists. Functions may be defined in different modules than expected.
8. **Changelog discipline**: CHANGELOG.md is for end users. Only log user-facing changes (features, behavior changes, bug fixes). Never log internal doc edits, CLAUDE.md updates, or refactors with no external effect.

## Troubleshooting

- **Syntax errors**: `bash -n <file>`
- **Linting**: `shellcheck <file>`
- **Stuck deploy**: `shipnode unlock`
- **Failed deploy**: `shipnode rollback`
- **Check health**: `shipnode doctor`
- **View logs**: `shipnode logs`

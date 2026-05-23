# @devalade/shipnode

Deploy Node.js apps to a single VPS — zero-downtime releases, PM2, Caddy, SSH, no Docker required.

## Install

```bash
npm install -g @devalade/shipnode
```

## Quick start

```bash
# 1. Generate config
shipnode init

# 2. Provision the server (Node, PM2, Caddy, mise)
shipnode setup

# 3. Deploy
shipnode deploy
```

## Configuration

`shipnode init` creates a `shipnode.config.ts` in your project root. You can also write it by hand using the fluent builder:

```ts
import { shipnode } from '@devalade/shipnode';

export default shipnode
  .backend()
  .ssh({ host: '1.2.3.4', user: 'deploy' })
  .deployTo('/var/www/myapp')
  .pm2('myapp', { instances: 2 })
  .port(3000)
  .domain('api.example.com')
  .healthCheck('/health')
  .nodeVersion('22')
  .pkgManager('pnpm')
  .build();
```

### Web + workers

A backend can run additional long-running processes alongside the web server. PM2 supervises all of them under one deployment.

```ts
export default shipnode
  .backend()
  .ssh({ host: '1.2.3.4', user: 'deploy' })
  .deployTo('/var/www/myapp')
  .pm2('myapp', { instances: 2 })
  .port(3000)
  .worker({ name: 'mailer', command: 'node dist/worker.js' })
  .worker({ name: 'cron', command: 'node dist/cron.js', env: { JOB: 'cleanup' } })
  .build();
```

After deploy, `shipnode status` lists every app, and `shipnode restart` / `stop` / `logs` operate on the whole deployment by default. Use `--process <name>` to target a single one (use the short name from your config — shipnode handles the PM2-side naming):

```bash
shipnode logs --process mailer
shipnode restart --process cron
```

> **Note on PM2 naming.** PM2 has a flat global namespace, so two deployments on the same host with a `worker` entry would collide. To prevent that, shipnode prefixes worker names with the deployment namespace when registering them with PM2. A config with `.pm2('api')` + `.worker({name: 'mailer'})` shows up in `pm2 list` as `api` and `api-mailer`. You always use the short name (`mailer`) in shipnode commands.

A backend can also be **worker-only** (no web server, no domain) — useful for queue consumers or cron runners. Just omit `.port(...)` and `.domain(...)`:

```ts
export default shipnode
  .backend()
  .ssh({ host: '1.2.3.4', user: 'deploy' })
  .deployTo('/var/www/queue-runner')
  .worker({ name: 'jobs', command: 'node dist/worker.js' })
  .build();
```

### Frontend apps

```ts
import { shipnode } from '@devalade/shipnode';

export default shipnode
  .frontend()
  .ssh({ host: '1.2.3.4', user: 'deploy' })
  .deployTo('/var/www/myapp')
  .domain('example.com')
  .buildDir('dist')
  .build();
```

### All options

| Method | Default | Description |
|---|---|---|
| `.backend()` / `.frontend()` | — | App type |
| `.ssh({ host, user, port?, identityFile? })` | port 22 | SSH connection |
| `.deployTo(path)` | `/var/www/app` | Remote deploy path |
| `.pm2(name, opts?)` | — | PM2 process name + options (the web app) |
| `.port(n)` | `3000` | Backend port (marks the entry as the web app) |
| `.worker({ name, command, ... })` | — | Add a worker process supervised alongside the web app |
| `.domain(d)` | — | Domain for Caddy config |
| `.nodeVersion(v)` | `lts` | Node version (via mise) |
| `.pkgManager(pm, opts?)` | auto-detected | `npm` \| `yarn` \| `pnpm` \| `bun`; `opts.installCommand` overrides the install command |
| `.installCommand(cmd)` | derived from pkg manager | Override the install command run on the server (e.g. `'npm ci --legacy-peer-deps'`). Equivalent to `pkgManager(pm, { installCommand: cmd })` |
| `.buildDir(dir)` | auto-detected | Frontend build output dir |
| `.zeroDowntime({ keepReleases? })` | true, 5 | Zero-downtime releases |
| `.legacy()` | — | Simple in-place deploy |
| `.healthCheck(path, opts?)` | `/health`, 30s, 3 retries | Post-deploy health check |
| `.noHealthCheck()` | — | Skip health check |
| `.envFile(f)` | `.env` | Local .env file to upload |
| `.sharedDirs(dirs)` | — | Dirs persisted across releases |
| `.sharedFiles(files)` | — | Files persisted across releases |
| `.database(opts)` | — | Database connection config |
| `.backup(opts)` | — | S3 backup config |
| `.cloudflare(opts)` | — | Cloudflare Tunnel config |
| `.preDeploy(fn)` | — | Hook: runs before symlink switch |
| `.postDeploy(fn)` | — | Hook: runs after deploy |

## Commands

### Core

```bash
shipnode init                  # Generate shipnode.config.ts interactively
shipnode setup                 # Install Node, PM2, Caddy, fail2ban on server
shipnode deploy                # Deploy (zero-downtime by default)
shipnode deploy --dry-run      # Preview without making changes
shipnode deploy --skip-build   # Skip local build step
shipnode doctor                # Check local + remote config
shipnode doctor --security     # Run security audit
shipnode status                # Show PM2 process status
```

### Release management

```bash
shipnode rollback              # Roll back to the previous release
shipnode rollback --steps 3    # Roll back 3 releases
shipnode migrate               # Migrate existing deploy to zero-downtime structure
```

### Environment

```bash
shipnode env                   # Upload local .env to server
shipnode run "npm run migrate" # Run a one-off command on the server
shipnode run bash              # Open an interactive shell
```

### Process management

```bash
shipnode logs                       # Tail PM2 logs for the whole deployment
shipnode logs --process mailer      # Tail logs for one app
shipnode logs --lines 500           # Show 500 lines
shipnode restart                    # Reload every app with --update-env
shipnode restart --process mailer   # Reload one app
shipnode stop                       # Stop every app in the deployment
shipnode stop --process mailer      # Stop one app
shipnode metrics                    # Open PM2 monit dashboard
```

### Security & maintenance

```bash
shipnode harden                # SSH hardening, UFW firewall, fail2ban
shipnode unlock                # Clear a stuck deployment lock
```

### Users

Manage SSH users via `.shipnode/users.yml`:

```yaml
- username: alice
  publicKey: ssh-ed25519 AAAA... alice@laptop
  sudo: true
- username: bob
  publicKey: ssh-ed25519 AAAA... bob@laptop
```

```bash
shipnode user sync             # Create/update users from users.yml
shipnode user list             # List non-system users on server
shipnode user remove alice     # Remove a user
```

### Backups

Requires `backup` config and `aws` CLI on the server.

```ts
export default shipnode
  // ...
  .backup({
    s3Bucket: 'my-backups',
    s3Prefix: 'myapp/',
    schedule: 'daily',        // hourly | daily | weekly
    retentionDays: 14,
  })
  .build();
```

```bash
shipnode backup setup          # Install backup script + systemd timer
shipnode backup run            # Run a backup immediately
shipnode backup status         # Show timer and last run log
shipnode backup list           # List recent backups in S3
```

### Cloudflare Tunnel

Expose your app and SSH through Cloudflare without opening ports. Requires `CLOUDFLARE_API_TOKEN` env var.

```ts
export default shipnode
  // ...
  .cloudflare({
    zone: 'example.com',
    appHostname: 'app.example.com',
    sshHostname: 'ssh.example.com',
    lockdownFirewall: true,    // Restrict inbound to CF IPs only
  })
  .build();
```

```bash
shipnode cloudflare init       # Install cloudflared, create tunnel, configure DNS
shipnode cloudflare audit      # Verify DNS records and tunnel
shipnode cloudflare status     # Show cloudflared service status
```

### CI/CD

```bash
shipnode ci github             # Generate .github/workflows/shipnode-deploy.yml
shipnode ci env-sync           # Push .env vars to GitHub repository secrets
```

### Configuration

```bash
shipnode config show           # Print resolved config
shipnode config validate       # Validate config file
shipnode config path           # Print path to config file
```

### Customization

```bash
shipnode eject pm2             # Eject PM2 ecosystem template to .shipnode/templates/
shipnode eject caddy           # Eject Caddy config template
shipnode eject all             # Eject all templates
shipnode upgrade               # Upgrade to the latest version
```

## Deploy hooks

Run code before or after the symlink switch:

```ts
export default shipnode
  .backend()
  // ...
  .preDeploy(async ({ exec }) => {
    await exec('npx prisma migrate deploy');
  })
  .postDeploy(async ({ exec, config }) => {
    await exec(`curl -s https://${config.domain}/health`);
  })
  .build();
```

## Zero-downtime releases

By default, shipnode uses a Capistrano-style release structure:

```
/var/www/myapp/
  releases/
    20240101T120000/   ← previous
    20240102T090000/   ← current (symlinked)
  shared/
    .env
    uploads/
  current -> releases/20240102T090000
```

PM2 is reloaded against `current/` after the symlink switch. If the health check fails, you can roll back instantly with `shipnode rollback`.

## Requirements

**Local:** Node ≥ 18, `rsync`, `ssh`

**Server:** Ubuntu/Debian (setup installs everything else via `apt`)

## License

MIT

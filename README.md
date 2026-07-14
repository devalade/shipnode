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

# 2. Provision the server. Installs Node, PM2, Caddy, mise, DB/Redis if
#    configured, and bootstraps a `deploy` user (sudo, NOPASSWD) keyed off
#    ${ssh.identityFile}.pub so subsequent runs don't need root SSH.
shipnode setup

# 3. Switch ssh.user in shipnode.config.ts to 'deploy', then lock down SSH:
shipnode harden

# 4. Deploy
shipnode deploy
```

Pass `--no-deploy-user` to `setup` if you want to manage users yourself.

## Configuration

`shipnode init` creates a `shipnode.config.ts` in your project root. You can also write it by hand using the fluent builder:

### Single app (simple)

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

### Multi-app workspace

A monorepo with two apps? Use `.apps([...])` to deploy them together:

```ts
const api = shipnode
  .app()
  .backend()
  .name('api')
  .appRoot('apps/backend')
  .domain('api.example.com')
  .port(3333)
  .pm2('api')
  .preDeploy(async ({ exec }) => exec('node ace.js migration:run --force'));

const web = shipnode
  .app()
  .frontend()
  .name('web')
  .appRoot('apps/frontend')
  .domain('www.example.com');

export default shipnode
  .ssh({ host: '1.2.3.4', user: 'deploy' })
  .deployTo('/var/www/example')
  .nodeVersion('22')
  .pkgManager('pnpm')
  .apps([api, web])
  .cloudflare({ zone: 'example.com', tunnelName: 'example' })
  .database({ type: 'postgres', host: 'localhost', port: 5432, name: 'example', user: 'example' })
  .build();
```

Each app gets its own release directory, Caddy site, PM2 ecosystem, and health check. Deploy everything with `shipnode deploy`, or target one app with `shipnode deploy --app api`.

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

### Multiple environments (staging, production, …)

Shipnode itself stays out of the environment concept — every command takes `--config <path>`, and you keep one config file per environment.

```
shipnode.staging.config.ts
shipnode.production.config.ts
```

```ts
// shipnode.staging.config.ts
import { shipnode } from '@devalade/shipnode';

export default shipnode
  .backend()
  .ssh({ host: 'staging.example.com', user: 'deploy' })
  .deployTo('/var/www/staging')
  .pm2('myapp-staging', { instances: 1 })
  .port(3000)
  .domain('staging.example.com')
  .envFile('.env.staging')
  .build();
```

```ts
// shipnode.production.config.ts
import { shipnode } from '@devalade/shipnode';

export default shipnode
  .backend()
  .ssh({ host: 'prod.example.com', user: 'deploy' })
  .deployTo('/var/www/prod')
  .pm2('myapp', { instances: 2, maxMemory: '1G' })
  .port(3000)
  .domain('api.example.com')
  .envFile('.env.production')
  .build();
```

```bash
shipnode deploy   --config shipnode.staging.config.ts
shipnode logs     --config shipnode.staging.config.ts
shipnode rollback --config shipnode.production.config.ts
```

Or factor the shared parts out and switch on an env var when you have many environments:

```ts
// shipnode.config.ts
import { shipnode } from '@devalade/shipnode';

const ENV = process.env.SHIPNODE_ENV ?? 'production';

const targets = {
  staging:    { host: 'staging.example.com', remotePath: '/var/www/staging', domain: 'staging.example.com', envFile: '.env.staging',    instances: 1 },
  production: { host: 'prod.example.com',    remotePath: '/var/www/prod',    domain: 'api.example.com',     envFile: '.env.production', instances: 2 },
} as const;

const t = targets[ENV as keyof typeof targets];
if (!t) throw new Error(`Unknown SHIPNODE_ENV: ${ENV}`);

export default shipnode
  .backend()
  .ssh({ host: t.host, user: 'deploy' })
  .deployTo(t.remotePath)
  .pm2(`myapp-${ENV}`, { instances: t.instances })
  .port(3000)
  .domain(t.domain)
  .envFile(t.envFile)
  .build();
```

```bash
SHIPNODE_ENV=staging    shipnode deploy
SHIPNODE_ENV=production shipnode deploy
```

The PM2 namespace prefix (`myapp-staging` vs `myapp`) keeps the processes distinct if you ever co-locate environments on one host.

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
| `.zeroDowntime(altPort?)` | automatic for Caddy backends | Force blue-green releases and optionally choose the green port |
| `.noZeroDowntime()` | — | Opt out and recreate PM2 processes during deploy |
| `.healthCheck(path, opts?)` | `/health`, 30s, 3 retries | Post-deploy health check |
| `.noHealthCheck()` | — | Skip health check |
| `.envFile(f)` | `.env` | Local .env file to upload |
| `.sharedDirs(dirs)` | — | Dirs persisted across releases |
| `.sharedFiles(files)` | — | Files persisted across releases |
| `.database(opts)` | — | Database connection config |
| `.backup(opts)` | — | S3 / R2 backup config (snapshot or incremental restic) |
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

`shipnode setup` bootstraps a `deploy` user by default (using `${ssh.identityFile}.pub`) and grants it passwordless sudo — this is the account subsequent `harden` and `deploy` runs authenticate as. Add teammates via:

```bash
shipnode user add alice --key ~/keys/alice.pub --sudo
shipnode user add ci    --key ~/keys/ci.pub                 # no sudo
```

This writes `.shipnode/users.yml` and syncs the entry to the server in one step. Add `--no-sync` to only write locally.

You can also edit `.shipnode/users.yml` by hand and run `shipnode user sync`:

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

Two strategies are supported:

- **`snapshot`** (default) — full `pg_dump` + `tar.gz` uploaded via `aws s3` each run. Simple, no client-side state, back-compat with pre-3.1 configs.
- **`restic`** — streams `pg_dump` straight into a [restic](https://restic.net/) repository on any S3-compatible store. Block-level dedup + client-side encryption + retention → daily incrementals are typically 1–5% of full size. Recommended for anything past a toy deployment.

#### Snapshot strategy

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

Requires `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in your local env and the `aws` CLI on the server (setup installs it).

#### Restic strategy (recommended)

Cloudflare R2 pairs well with restic — S3-compatible API, zero egress fees, so full-repo restores stay cheap.

```ts
export default shipnode
  // ...
  .backup({
    strategy: 'restic',
    s3Bucket: 'my-backups',
    s3Endpoint: 'https://<account-id>.r2.cloudflarestorage.com',
    schedule: 'daily',
    keepDaily: 7,
    keepWeekly: 4,
    keepMonthly: 6,
  })
  .build();
```

Requires three env vars locally at `setup` time:

- `AWS_ACCESS_KEY_ID` — R2 API token access key (create at Cloudflare dashboard → R2 → Manage R2 API Tokens with Object Read & Write)
- `AWS_SECRET_ACCESS_KEY` — the matching secret
- `RESTIC_PASSWORD` — encryption passphrase. **Save this outside the server.** If you lose it the repository is unrecoverable. Omit and shipnode generates one and prints it.

Setup installs restic, writes `/etc/shipnode/backup.env` (root-owned 600), the backup script, and a systemd unit + timer. On the first run restic initializes the R2 repository; subsequent runs stream `pg_dump` via `--stdin`, back up `shared/` files, and prune with the configured retention.

#### Commands

```bash
shipnode backup setup                              # Install/refresh script + timer + env
shipnode backup run                                # Run a backup immediately
shipnode backup status                             # Show timer and last run log
shipnode backup list                               # Snapshots (restic) or S3 objects (snapshot)
shipnode backup restore --tag db --target /tmp/r   # Restore latest DB snapshot (restic only)
shipnode backup restore <id> --tag files           # Restore a specific snapshot
```

`backup restore` extracts files to the target directory but never applies them — a bad restore should not silently trash production. Run the actual recovery step by hand:

```bash
# On the server, once restore extracted the snapshot:
psql -U <user> -d <db> -f /tmp/restore/db.sql
rsync -a /tmp/restore/var/www/<app>/shared/ /var/www/<app>/shared/
```

### Cloudflare Tunnel

Expose your apps (and optionally SSH) through Cloudflare without opening ports. Ingress entries are derived automatically from each app's `.domain()` + web port, so there is no `appHostname` to configure — the tunnel routes `app.domain → localhost:<port>` for every app in the workspace.

Requires a `CLOUDFLARE_API_TOKEN` env var with:

- `Zone:Zone:Read` + `Zone:DNS:Read` + `Zone:DNS:Edit` on the target zone
- `Account:Cloudflare Tunnel:Edit` on the account

Create it at https://dash.cloudflare.com/profile/api-tokens.

```ts
export default shipnode
  // ...
  .cloudflare({
    zone: 'example.com',
    tunnelName: 'myapp',       // optional, defaults to a slug of ssh.host
    sshHostname: 'ssh.example.com', // optional — adds an ssh://localhost:22 ingress
    lockdownFirewall: true,    // Restrict inbound to CF IPs only
  })
  .build();
```

```bash
shipnode cloudflare init       # Install cloudflared, create tunnel via API, wire DNS
shipnode cloudflare audit      # Verify DNS records and tunnel
shipnode cloudflare status     # Show cloudflared service + config
```

`cloudflare init` finds-or-creates the tunnel via the Cloudflare REST API (no browser-based `cloudflared tunnel login` step), writes the credentials JSON to `/etc/cloudflared/<id>.json`, upserts CNAME records pointing at `<id>.cfargotunnel.com`, and enables the systemd unit. Reusing a tunnel by name across hosts is not supported — Cloudflare doesn't echo the secret back on GET, so credentials from another host would need to be copied over manually.

Falls back to installing `cloudflared` from the upstream GitHub `.deb` if `pkg.cloudflare.com` has no package for your Ubuntu codename (a common issue on very fresh releases like 26.04/`resolute`).

### CI/CD

```bash
shipnode ci github             # Generate .github/workflows/shipnode-deploy.yml
shipnode ci env-sync           # Push .env vars to GitHub repository secrets
```

### Configuration

```bash
shipnode config show                  # Print resolved workspace + every app
shipnode config show --app api        # Narrow to a single app in a multi-app workspace
shipnode config validate              # Validate config file
shipnode config path                  # Print path to config file
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

Backends with a domain and a PM2 web port use blue-green releases automatically. Shipnode starts the new web process on the idle port, checks it, and reloads Caddy only after it is healthy. Apps without a domain and worker-only apps keep the PM2 recreate path. Use `.noZeroDowntime()` to opt out explicitly; raw configuration may set `zeroDowntime: false`.

Blue-green keeps the previous and current web processes resident, so budget about **2× the web process memory**. On an eligible Caddy backend, `.zeroDowntime(altPort?)` remains available to force the mode and choose the alternate port. By default, Shipnode uses a less commonly occupied port offset by 10,000 (`3000 → 13000`); near the top of the TCP range it subtracts 10,000 instead.

Every app still uses a Capistrano-style release structure:

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

On the first migration, the new release starts on green while the existing uncoloured process keeps serving on blue. After health succeeds and Caddy reloads, Shipnode removes that legacy process. If health fails, Caddy and the legacy process remain untouched.

## Requirements

**Local:** Node ≥ 18, `rsync`, `ssh`

**Server:** Ubuntu/Debian (setup installs everything else via `apt`)

## License

MIT

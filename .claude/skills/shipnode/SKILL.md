---
name: shipnode
description: Deploy Node.js apps to a single VPS using the shipnode CLI (zero-downtime releases, PM2, Caddy, SSH). Use when the user asks about deploying, setting up a server, rolling back, configuring Caddy/PM2, managing .env on a remote server, or running shipnode commands.
---

# shipnode

## Quick start

```bash
shipnode init        # generate shipnode.config.ts interactively
shipnode setup       # provision the server (Node, PM2, Caddy, mise)
shipnode deploy      # first deploy
```

## Config builder

`shipnode.config.ts` — backend app:

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

Frontend app: swap `.backend()` → `.frontend()`, add `.buildDir('dist')`, drop `.pm2()` / `.port()`.

## Workflows

### First deploy to a new server
1. `shipnode init` — creates config
2. `shipnode setup` — installs Node/PM2/Caddy on server
3. `shipnode env` — uploads .env
4. `shipnode deploy`

### Zero-downtime is the default
Releases live in `/remotePath/releases/<timestamp>/`. Current symlink is atomically switched.
To opt out: add `.legacy()` to the builder.

### Rollback
```bash
shipnode rollback              # go back one release
shipnode rollback --steps 3    # go back three releases
```

### Database migrations in deploy
```ts
.preDeploy(async ({ exec }) => {
  await exec('npx prisma migrate deploy');
})
```

### CI/CD (GitHub Actions)
```bash
shipnode ci github             # writes .github/workflows/shipnode-deploy.yml
shipnode ci env-sync           # pushes .env vars → GitHub repo secrets
```

### Stuck deploy lock
```bash
shipnode unlock
```

### Security hardening
```bash
shipnode doctor --security     # audit first
shipnode harden                # SSH hardening, UFW, fail2ban
shipnode cloudflare init       # optional: tunnel + lockdown firewall
```

### Backups to S3
Add `.backup({ s3Bucket, s3Prefix, schedule, retentionDays })` to config, then:
```bash
shipnode backup setup          # install systemd timer on server
shipnode backup run            # immediate backup
shipnode backup list           # list recent backups
```

## Day-to-day commands

```bash
shipnode status                # PM2 process status
shipnode logs                  # tail last 100 lines
shipnode logs --lines 500
shipnode restart               # reload PM2 with --update-env
shipnode stop
shipnode run "npm run migrate" # one-off remote command
shipnode run bash              # interactive shell
shipnode metrics               # PM2 dashboard
shipnode deploy --dry-run      # preview without changes
shipnode deploy --skip-build   # skip local build
```

See [REFERENCE.md](REFERENCE.md) for the full command & config option reference.

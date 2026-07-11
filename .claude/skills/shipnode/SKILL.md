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

### Releases + zero-downtime
Releases live in `/remotePath/releases/<timestamp>/`. Current symlink is atomically switched.
Backend apps can opt into blue-green with `.zeroDowntime()` — boot idle colour, health-check, then flip Caddy.

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

## Troubleshooting

### Build fails on remote but works locally

**Symptom:** TypeScript or compilation errors appear during `shipnode deploy` that don't show up when running locally.

**Cause:** Locally you're likely running `next dev`, which skips type checking. The remote always runs `next build`, which runs the full TypeScript compiler. A newer TypeScript version resolved on the remote (fresh `pnpm install`) can also surface errors that an older local version missed.

**Fix:** Run `pnpm build` locally before deploying to catch the same errors the remote will see.

---

### Prisma — `Module '@prisma/client' has no exported member 'X'` or implicit `any` on Prisma query results

**Symptom:** Build fails with a missing Prisma type export, or Prisma query results have implicit `any` type.

**Cause:** `prisma generate` was not run before `next build`. Without it the Prisma client types don't exist, so all Prisma results are untyped.

**What doesn't work:** Putting `prisma generate` in `.preDeploy()` runs it *after* the build — too late.

**Fix:** Add it to the `build` script in `package.json` so it runs before Next.js compiles:

```json
"build": "prisma generate && next build"
```

For migrations, keep `prisma migrate deploy` in `.preDeploy()` — that's the right place since it needs the database to be reachable at deploy time, not at build time:

```ts
.preDeploy(async ({ exec }) => {
  await exec('pnpm db:apply'); // runs prisma migrate deploy
})
```

---

### Port configuration — how it works

Shipnode sets the `PORT` environment variable in the PM2 ecosystem file based on the `.port(n)` value in `shipnode.config.ts`. PM2 passes it to the Node.js process at startup.

```
.port(3001)  →  PM2 env: { PORT: 3001 }  →  process.env.PORT = '3001'
```

Next.js 13.5+ reads `process.env.PORT` automatically when no `-p` flag is given. No changes are needed in `package.json` or the app code.

**Multiple apps on one server:** give each app a unique port in its config — Caddy proxies each domain to the correct port:

```ts
// app-one/shipnode.config.ts
.port(3001)

// app-two/shipnode.config.ts
.port(3002)
```

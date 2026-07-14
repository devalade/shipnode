---
name: shipnode
description: Deploy Node.js apps to a single VPS with the shipnode CLI v3 (multi-app workspaces, blue-green releases, PM2, Caddy, SSH, accessories, backups). Use when the user asks about deploying, setting up a server, rolling back, configuring Caddy/PM2, multi-app monorepos, .env on a remote server, accessories/Docker sidecars, or running shipnode commands.
---

# shipnode (v3)

Package: `@devalade/shipnode` (v3 line; alpha tag may be newer than `latest`).

## Quick start

```bash
shipnode init        # generate shipnode.config.ts
shipnode setup       # provision server (deploy user, Node, PM2, Caddy, mise)
shipnode env         # upload .env → shared/
shipnode deploy      # first deploy
```

## Config models

**Workspace** (shared): `ssh`, `servers`, `deployTo`, `nodeVersion`, `pkgManager`, `installCommand`, `database`, `redis`, `backup`, `cloudflare`, `aliases`, `registry`, `accessories`.

**Per-app**: `name`, `appType`, `appRoot`, `domain`, `port` / `pm2` / `worker`, `healthCheck`, `envFile`, `keepReleases`, `zeroDowntime`, `sharedDirs`/`sharedFiles`, `hooks`, `dependsOn`, `on` (server target), `caddy`.

Single-app 2.x style still works (top-level `.backend()` etc. → synthesized as `apps[0]`). Prefer explicit `.apps([...])` for monorepos.

### Single app

```ts
import { shipnode } from '@devalade/shipnode';

export default shipnode
  .backend()
  .ssh({ host: '1.2.3.4', user: 'deploy' })
  .deployTo('/var/www/myapp')
  .pm2('myapp', { instances: 2 })
  .port(3000)
  .worker({ name: 'worker', command: 'node dist/worker.js' })
  .domain('api.example.com')
  .healthCheck('/health')
  .nodeVersion('22')
  .pkgManager('pnpm')
  .build();
```

Frontend: `.frontend()`, `.buildDir('dist')`, no `.pm2()` / `.port()`.

### Multi-app workspace

Layout on server: `<remotePath>/<app-name>/releases/<ts>/` + `current` symlink.

```ts
import { shipnode, app } from '@devalade/shipnode';

const api = app()
  .backend()
  .name('api')
  .appRoot('apps/backend')
  .domain('api.example.com')
  .port(3333)
  .envFile('apps/backend/.env.production')
  .preDeploy(async ({ exec }) => {
    await exec('pnpm db:apply');
  });

const web = app()
  .frontend()
  .name('web')
  .appRoot('apps/web')
  .domain('example.com')
  .buildDir('dist')
  .envFile('apps/web/.env.production');

export default shipnode
  .ssh({ host: '1.2.3.4', user: 'deploy' })
  .deployTo('/var/www/example')
  .nodeVersion('24')
  .pkgManager('pnpm')
  .apps([api, web])
  .build();
```

Target one app: `shipnode deploy --app api`, `shipnode logs --app web`. `rollback` requires `--app`.

## Workflows

### First deploy
1. `shipnode init`
2. `shipnode setup` — creates `deploy` user by default (`--no-deploy-user` to skip)
3. `shipnode env` (per app if multi-app: `--app api`)
4. `shipnode deploy`

### Releases
Every deploy uses release dirs + atomic `current` symlink. Failed deploys revert `current` (when a previous release exists) and record `status: 'failed'`.

**Blue-green (automatic):** backends with a domain and web `.port()` boot the idle colour → health (web only) → reload workers → flip Caddy. The green port defaults to an uncommon port offset by 10,000 (`3000 → 13000`), subtracting 10,000 above 55535. Use `.zeroDowntime(altPort?)` to force the mode or choose the alternate port, and `.noZeroDowntime()` to opt out. Rollback is an instant Caddy flip to the previous colour (one step).

### Rollback
```bash
shipnode rollback --app api           # one release back
shipnode rollback --app api --steps 3
```

### Migrations
```ts
.preDeploy(async ({ exec }) => {
  await exec('pnpm db:apply'); // after remote build, before go-live
})
```
`prisma generate` belongs in `package.json` `"build"`, not `preDeploy`.

### Accessories (Docker sidecars)
```ts
.accessories({
  postgres: {
    image: 'postgres:16',
    port: '5432:5432',
    env: { POSTGRES_PASSWORD: '${POSTGRES_PASSWORD}' },
    volumes: ['pgdata:/var/lib/postgresql/data'],
  },
})
// per-app: .dependsOn(['postgres'])
```
```bash
shipnode accessory status
shipnode accessory logs postgres
shipnode registry login    # if private image
shipnode secret set POSTGRES_PASSWORD
```

### Backups
```ts
.backup({
  s3Bucket: 'my-backups',
  s3Endpoint: 'https://<account>.r2.cloudflarestorage.com',
  strategy: 'restic',       // or 'snapshot' (default)
  schedule: 'daily',
  keepDaily: 7,
})
```
```bash
shipnode backup setup
shipnode backup run
shipnode backup list
shipnode backup restore latest --target /tmp/restore
```

### Security / Cloudflare
```bash
shipnode doctor --security
shipnode harden
shipnode cloudflare init   # one tunnel, ingress per app domain
```

### Monitor
```bash
shipnode monitor           # live TUI: PM2, system, health, logs
shipnode monitor --app api
```

## Day-to-day

```bash
shipnode status [--app name]
shipnode logs [--app name] [--lines 500]
shipnode restart [--app name]
shipnode stop [--app name]
shipnode run "pnpm db:apply" [--app name]
shipnode run bash
shipnode deploy --dry-run
shipnode deploy --skip-build
shipnode unlock            # stuck .shipnode/deploy.lock (directory)
shipnode config show [--app name]
shipnode user add alice --key ~/.ssh/alice.pub --sudo
```

See [REFERENCE.md](REFERENCE.md) for the full v3 command & builder tables.
Still on 2.x / reading an old config? See [REFERENCE-v2.md](REFERENCE-v2.md).


## Troubleshooting

### Build fails on remote, works locally
Remote runs full `build` (e.g. `next build` + tsc). Run `pnpm build` locally first.

### Prisma types missing at build
Put `prisma generate` in `"build"` script. Migrations stay in `.preDeploy()`.

### PORT
`.port(n)` → PM2 `env.PORT`. Next.js 13.5+ reads it automatically. Multi-app: unique ports per app.

### pnpm ignored build scripts
Deploy fails fast on `ERR_PNPM_IGNORED_BUILDS`. Fix: `pnpm approve-builds`, commit, redeploy.

### Stuck lock
Lock is `.shipnode/deploy.lock/` (mkdir). Clear with `shipnode unlock` after confirming no deploy running.

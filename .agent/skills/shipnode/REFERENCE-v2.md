# shipnode 2.x Reference

For projects still on `@devalade/shipnode@2` (`latest` on npm as of 2.5.x).  
For v3, use [REFERENCE.md](REFERENCE.md). Migration: `docs/migrations/2.x-to-3.0.md`.

## Mental model

- **One app per config file.** Multi-app = multiple `shipnode.*.config.ts` files + multiple deploys.
- **Flat config.** Domain, pm2, healthCheck, envFile, hooks live on the root builder / root `ShipnodeConfig` (not `apps[]`).
- **Disk layout:** `<remotePath>/releases/<ts>/` + `<remotePath>/current` (no per-app subdirectory).
- **Releases are always on** (since 2.0.13). There is no `.legacy()` in-place mode. Keep N releases with `.keepReleases(n)` (default 5).
- Note: early 2.0 docs mentioned `.legacy()` / `.zeroDowntime()` for release vs in-place — those methods were **removed** in 2.0.13. Ignore them on 2.5.x.

## Quick config (2.x)

```ts
import { shipnode } from '@devalade/shipnode';

export default shipnode
  .backend()
  .ssh({ host: '1.2.3.4', user: 'deploy' })
  .deployTo('/var/www/myapp')
  .pm2('myapp', { instances: 2 })
  .port(3000)
  .worker({ name: 'worker', command: 'node dist/worker.js' }) // 2.3+
  .domain('api.example.com')
  .healthCheck('/health')
  .keepReleases(5)
  .envFile('.env')
  .nodeVersion('22')
  .pkgManager('pnpm')
  .preDeploy(async ({ exec }) => {
    await exec('npx prisma migrate deploy');
  })
  .aliases({ migrate: 'pnpm db:apply' })
  .build();
```

Frontend: `.frontend()`, `.buildDir('dist')`, drop `.pm2()` / `.port()`.

Monorepo: either `.appRoot('apps/backend')` in one config, or separate config files + `--config`.

## Commands (2.x)

No `--app` flag. Target a different app by `--config path/to/other.config.ts`.

| Command | Description |
|---|---|
| `init` | Generate shipnode.config.ts |
| `setup` | Install Node, PM2, Caddy, mise |
| `deploy [--dry-run] [--skip-build]` | Deploy |
| `doctor [--security]` | Config / security check |
| `status` | PM2 status |
| `rollback [--steps n]` | Roll back n releases (default 1) |
| `migrate` | In-place → release structure |
| `env [--file path]` | Upload .env to `shared/` |
| `run [cmd] [--tty]` | Remote command / alias |
| `logs [--lines n]` | PM2 logs |
| `restart` / `stop` | Process control |
| `metrics` | PM2 monit |
| `unlock` | Clear `<remotePath>/.shipnode/deploy.lock` (file in 2.x) |
| `harden` | SSH / UFW / fail2ban |
| `user sync` / `list` / `remove` | Users from `.shipnode/users.yml` |
| `backup setup` / `run` / `status` / `list` | Snapshot-style S3 backups |
| `cloudflare init` / `audit` / `status` | Tunnel (uses `appHostname` in older configs) |
| `ci github` / `ci env-sync` | GitHub Actions |
| `config show` / `validate` / `path` | Config helpers |
| `eject` / `upgrade` | Templates / self-upgrade |

## Builder DSL (2.x)

| Method | Notes |
|---|---|
| `.backend()` / `.frontend()` | App type |
| `.ssh({ host, user, port?, identityFile? })` | SSH |
| `.deployTo(path)` | Remote path (releases live directly under it) |
| `.pm2(name, opts?)` | Primary process |
| `.port(n)` | Web port → `PORT` env; marks web app |
| `.worker(opts)` | Extra PM2 process (2.3+) |
| `.domain(d)` | Caddy site |
| `.keepReleases(n)` | Retention (default 5) |
| `.healthCheck(path, opts?)` / `.noHealthCheck()` | Probe |
| `.envFile(f)` | Shared env |
| `.sharedDirs` / `.sharedFiles` | Persist across releases |
| `.appRoot(dir)` | Monorepo subdir |
| `.buildDir(dir)` | Frontend output |
| `.nodeVersion` / `.pkgManager` / `.installCommand` | Runtime |
| `.database` / `.redis` / `.backup` / `.cloudflare` | Infra |
| `.preDeploy` / `.postDeploy` | Hooks |
| `.aliases(map)` | `shipnode run <name>` |

**Not in 2.x:** `.apps([...])`, `.app()`, `.zeroDowntime()` (v3 blue-green), `.accessories()`, `.registry()`, `.servers()` / `.on()`, `monitor`, `backup restore`, `user add`, `accessory *`, `secret *`, `registry login`.

## Paths (2.x)

| Path | Purpose |
|---|---|
| `<remotePath>/releases/<ts>/` | Release |
| `<remotePath>/current` | Active symlink |
| `<remotePath>/shared/` | Env + shared files |
| `<remotePath>/.shipnode/releases.json` | History |
| `<remotePath>/.shipnode/deploy.lock` | Lock **file** |

## Cloudflare (2.x)

Older configs used `cloudflare: { zone, appHostname }`. Ingress was single-hostname. In 3.x, `appHostname` is removed — use per-app `.domain()` instead.

## Reading config programmatically (2.x)

```ts
config.app          // 'backend' | 'frontend'
config.domain
config.pm2
config.healthCheck
config.envFile
// ...
```

In 3.x these root mirrors are gone — use `config.apps[0].…`.

## Migrating to 3.x

See [REFERENCE.md](REFERENCE.md) and repo `docs/migrations/2.x-to-3.0.md`.

Short version:

1. Builder-only single-app configs usually keep working (synthesized to `apps[0]`).
2. Prefer `.apps([api, web])` for monorepos.
3. Disk moves to `<remotePath>/<app-name>/…` — clean up old root `releases/` / `current` after first 3.x deploy.
4. Use `--app` on CLI; `rollback` requires it when multiple apps exist.
5. Install: `npm i -D @devalade/shipnode@3` or `@alpha` while v3 is pre-release.

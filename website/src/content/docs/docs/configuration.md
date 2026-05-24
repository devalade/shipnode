---
title: shipnode.config.ts
description: The typed fluent-builder config that drives every deploy.
---

Every ShipNode project has a `shipnode.config.ts` at the root. `shipnode init` generates it interactively; you can also write it by hand.

## Minimal backend

```ts
import { shipnode } from '@devalade/shipnode';

export default shipnode
  .backend()
  .ssh({ host: '203.0.113.10', user: 'deploy' })
  .deployTo('/var/www/api')
  .pm2('api', { instances: 2 })
  .port(3000)
  .domain('api.example.com')
  .healthCheck('/health')
  .nodeVersion('22')
  .pkgManager('pnpm')
  .build();
```

## Static frontend

```ts
import { shipnode } from '@devalade/shipnode';

export default shipnode
  .frontend()
  .ssh({ host: '203.0.113.10', user: 'deploy' })
  .deployTo('/var/www/web')
  .domain('example.com')
  .buildOutput('dist')
  .build();
```

## Method reference

| Method | Purpose |
|---|---|
| `.backend()` / `.frontend()` | App type. Backend uses PM2; frontend is served as static files by Caddy. |
| `.ssh({ host, user, port? })` | SSH target. Port defaults to 22. |
| `.deployTo(path)` | Absolute path on the server (e.g. `/var/www/api`). |
| `.pm2(name, opts?)` | PM2 app name + options (`{ instances, exec_mode }`). Backend only. |
| `.port(n)` | App's listening port. Caddy reverse-proxies to it. |
| `.domain(host)` | Public hostname. Caddy issues + renews certs. |
| `.healthCheck(path, opts?)` | GET path the deploy must hit after reload. |
| `.nodeVersion(v)` | Node major version pinned via mise. |
| `.pkgManager('npm' \| 'pnpm' \| 'yarn' \| 'bun')` | How to install + build. |
| `.worker({ name, command, env? })` | Extra long-running PM2 process. Can be repeated. |
| `.env(path)` | Path to a `.env` file uploaded as `shared/.env`. |
| `.keepReleases(n)` | How many old releases to keep on disk (default 5). |
| `.zeroDowntime(bool)` | Toggle the symlink-flip release strategy. |
| `.build()` | Required terminal call. Returns the resolved config. |

## Where the config can live

Default: `./shipnode.config.ts`. Override with `--config <path>` on any command — useful for multi-environment setups (see [Multi-environment](/docs/environments/)).

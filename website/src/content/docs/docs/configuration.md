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

## Multiple servers and accessories

Use `.ssh(...)` for a single server. Use `.servers({ user, hosts })` when apps and Docker accessories should live on different hosts — one object, a shared SSH user, and the list of hosts. The host string is each server's identity everywhere else.

```ts
import { shipnode } from '@devalade/shipnode';

export default shipnode
  .servers({
    user: 'deploy',
    hosts: ['203.0.113.10', '203.0.113.20'],
  })
  .deployTo('/var/www/api')
  .registry({
    server: 'ghcr.io',
    username: 'my-org',
    passwordEnv: 'REGISTRY_TOKEN',
  })
  .accessories({
    redis: {
      image: 'redis:7',
      on: '203.0.113.20',
      port: '127.0.0.1:6379:6379',
      directories: ['api-redis:/data'],
      healthCheck: { command: 'redis-cli ping' },
    },
  })
  .apps([
    shipnode.app()
      .name('api')
      .backend()
      .on('203.0.113.10')
      .domain('api.example.com')
      .pm2('api')
      .port(3000)
      .caddy({
        append: 'header X-Content-Type-Options "nosniff"',
      }),
  ])
  .build();
```

Targets are single-host in this version (one host per app or accessory — an app on *several* hosts is a fleet, see the [load balancer guide](/docs/load-balancer)). ShipNode does not provision a load balancer, and Docker Compose is not used.

Accessory management commands:

```bash
shipnode accessory status
shipnode accessory logs redis --lines 200
shipnode accessory restart redis
shipnode accessory stop redis
shipnode accessory health redis
```

Registry passwords are read from environment variables on the remote host. If `REGISTRY_TOKEN` is missing remotely, accessory deploy fails before `docker login` with a clear error.

`shipnode deploy --dry-run` includes the generated Caddy site block for each app with a domain, including any appended directives.

## Method reference

| Method | Purpose |
|---|---|
| `.backend()` / `.frontend()` | App type. Backend uses PM2; frontend is served as static files by Caddy. |
| `.ssh({ host, user, port? })` | SSH target. Port defaults to 22. |
| `.servers({ user, hosts })` | All servers: a shared SSH user and the list of hosts. |
| `.deployTo(path)` | Absolute path on the server (e.g. `/var/www/api`). |
| `.on(...hosts)` | Assign an app to one or more hosts. More than one is a fleet. |
| `.registry({ server, username, passwordEnv })` | Docker registry auth used by accessories. |
| `.accessories({ name: config })` | Workspace-level Docker containers shared by apps. |
| `.caddy({ append })` | Append raw Caddy directives inside the generated site block. |
| `.pm2(name, opts?)` | PM2 app name + options (`{ instances, exec_mode }`). Backend only. |
| `.port(n)` | App's listening port. Caddy reverse-proxies to it. |
| `.domain(host)` | Public hostname. Caddy issues + renews certs. |
| `.healthCheck(path, opts?)` | GET path the deploy must hit after reload. |
| `.nodeVersion(v)` | Node major version pinned via mise. |
| `.pkgManager('npm' \| 'pnpm' \| 'yarn' \| 'bun')` | How to install + build. |
| `.worker({ name, command, env? })` | Extra long-running PM2 process. Can be repeated. |
| `.env(path)` | Path to a `.env` file uploaded as `shared/.env`. |
| `.keepReleases(n)` | How many old releases to keep on disk (default 5). |
| `.zeroDowntime(altPort?)` | Force blue-green on a Caddy backend and optionally choose its alternate port. |
| `.noZeroDowntime()` | Opt out of automatic blue-green for a Caddy backend. |
| `.aliases({ name: cmd })` | Define short names for `shipnode run` (see [Aliases](#aliases)). |
| `.preDeploy(fn)` | Run a function on the server before the health check (see [Hooks](#hooks)). |
| `.postDeploy(fn)` | Run a function on the server after a healthy release. |
| `.build()` | Required terminal call. Returns the resolved config. |

Backend apps with both `.domain(...)` and a PM2 web `.port(...)` use blue-green deploys by default. The alternate port defaults to a less commonly occupied value offset by 10,000 (`3000 → 13000`), with a subtraction near the top of the TCP range. They temporarily need about 2× the web process memory while both colours are resident. Backends without a domain and worker-only apps use PM2 recreate. Raw configs can opt out with `zeroDowntime: false`.

## Aliases

`shipnode run` matches its first argument against the alias map and expands it. Useful for one-off operational commands you don't want to memorize.

```ts
export default shipnode
  .backend()
  .ssh({ host: '203.0.113.10', user: 'root' })
  .deployTo('/var/www/api')
  .pm2('api')
  .port(3000)
  .aliases({
    migrate: 'pnpm prisma migrate deploy',
    seed:    'pnpm tsx scripts/seed.ts',
    repl:    'node --experimental-repl-await',
  })
  .build();
```

Now on the server:

```bash
npx shipnode run "migrate"
# -> runs `pnpm prisma migrate deploy` inside the current release
npx shipnode run "seed"
```

Anything after the alias name is appended to the expanded command, so `shipnode run "migrate --create-only"` works.

## Hooks

Hooks let you run logic on the server at well-defined points in the deploy. They receive a typed context with the resolved config and a server-side `exec` helper that runs inside the release directory with the project's environment loaded.

```ts
export default shipnode
  .backend()
  .ssh({ host: '203.0.113.10', user: 'root' })
  .deployTo('/var/www/api')
  .pm2('api')
  .port(3000)
  .preDeploy(async (ctx) => {
    // Runs inside the new release, before PM2 reload + health check.
    await ctx.exec('pnpm prisma migrate deploy');
  })
  .postDeploy(async (ctx) => {
    // Runs after the release is healthy.
    await ctx.exec('curl -X POST $SLACK_WEBHOOK -d \'{"text":"deployed"}\'');
  })
  .build();
```

### When each hook runs

| Hook | Timing |
|---|---|
| `preDeploy` | After install + build + symlink flip, **before** PM2 reload and the health check. Throw to abort the deploy — the symlink rolls back. |
| `postDeploy` | After the health check passes. Failures here log but do not roll back the release. |

### The context

```ts
type HookFn = (ctx: HookContext) => Promise<void> | void;

interface HookContext {
  config: ShipnodeConfig;            // the resolved config for this deploy
  release?: string;                  // the new release directory (absolute path on the server)
  env: string;                       // 'production' for now
  exec(cmd: string,
       options?: { cwd?: string; env?: Record<string, string>; timeout?: number }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
```

`ctx.exec` runs the command on the **remote** server, in the new release directory, with `mise` in `PATH` (so `node`, `pnpm`, etc. are available). Stdout streams to your terminal prefixed with `│`. Non-zero exit throws — that's enough to fail the deploy from a `preDeploy` hook.

See [Recipes](/docs/recipes/) for ready-to-paste hook patterns (Prisma migrations, Slack notifications, Sentry releases, CDN purge, cache priming).

## Where the config can live

Default: `./shipnode.config.ts`. Override with `--config <path>` on any command — useful for multi-environment setups (see [Multi-environment](/docs/environments/)).

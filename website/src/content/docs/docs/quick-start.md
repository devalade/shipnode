---
title: Quick start
description: Three commands from empty server to deployed app.
---

After [installing shipnode](/docs/install/) in your project:

```bash
# 1. Generate config (interactive — detects framework, package manager, app type)
npx shipnode init

# 2. Provision the server (Node.js, PM2, Caddy, package manager)
npx shipnode setup

# 3. Deploy
npx shipnode deploy
```

That's the full path. `init` writes `shipnode.config.ts`. `setup` is a one-time server provision. `deploy` builds, syncs, releases, reloads PM2, and health-checks before declaring the release healthy.

## What the deploy actually does

```
rsync           ./  ->  /var/www/api/releases/20260524160000
install         pnpm install --frozen-lockfile
build           pnpm run build
symlink         current -> releases/20260524160000
pm2             reload api --update-env
health          GET /health  200 OK  47ms
deployed        https://api.example.com
```

If the health check fails, the symlink stays on the previous release and the new one is discarded.

## Roll back

```bash
npx shipnode rollback --steps 1
```

## Next

- [Configuration](/docs/configuration/) — the full `shipnode.config.ts` reference
- [Multi-environment](/docs/environments/) — staging + production from one repo
- [CI/CD](/docs/ci-cd/) — generate a GitHub Actions workflow

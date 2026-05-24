---
title: shipnode deploy
description: Build, sync, release, health-check.
---

The main command. Builds the app, rsyncs it to a new timestamped release directory, installs deps on the server, flips the `current` symlink atomically, reloads PM2 with `--update-env`, and health-checks the new release.

```bash
npx shipnode deploy
```

If the health check fails, the symlink stays on the previous release and the failed release is discarded.

## Options

| Flag | Purpose |
|---|---|
| `--dry-run` | Print what would happen without changing anything on the server. |
| `--skip-build` | Skip the local `build` step (use existing build output). |
| `--config <path>` | Deploy a non-default environment, e.g. `--config shipnode.staging.config.ts`. |

## Release layout

```
/var/www/api/
  current -> releases/20260524160000
  releases/
    20260524150000/
    20260524160000/
  shared/
    .env
    ecosystem.config.cjs
  .shipnode/
    releases.json
    deploy.lock
```

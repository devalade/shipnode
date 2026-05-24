---
title: shipnode rollback
description: Point current at an earlier release.
---

Move the `current` symlink back to a previous release and reload PM2.

```bash
npx shipnode rollback --steps 1
```

## Options

| Flag | Purpose |
|---|---|
| `--steps <n>` | Number of releases to go back. Default `1`. |
| `--config <path>` | Use a non-default config file. |

## How many releases are kept?

`keepReleases` in `shipnode.config.ts` (default 5). Older release directories are pruned after each successful deploy.

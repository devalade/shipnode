---
title: shipnode status
description: Inspect PM2 state, the active release, and recent deploys.
---

```bash
npx shipnode status
```

Prints:

- PM2 process list for the deployment (web + workers)
- The release currently pointed at by `current`
- Recent releases from `.shipnode/releases.json`
- Whether a deploy lock is held

## Options

| Flag | Purpose |
|---|---|
| `--config <path>` | Use a non-default config file. |

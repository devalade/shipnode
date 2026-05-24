---
title: shipnode unlock
description: Clear a stuck deploy lock.
---

ShipNode holds a lock file at `<deployPath>/.shipnode/deploy.lock` during a deploy. If a deploy is killed (network drop, Ctrl-C at the wrong moment), the lock can linger and block the next deploy.

```bash
npx shipnode unlock
```

Only run this after confirming no deploy is actually in progress.

## Options

| Flag | Purpose |
|---|---|
| `--config <path>` | Use a non-default config file. |

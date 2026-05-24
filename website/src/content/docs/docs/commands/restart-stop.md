---
title: shipnode restart / stop
description: Control PM2 processes without redeploying.
---

```bash
npx shipnode restart
npx shipnode stop
```

Restart reloads PM2 with `--update-env` so any new `shared/.env` values pick up. Stop halts the processes without removing them — `restart` brings them back.

## Options

| Flag | Purpose |
|---|---|
| `--process <name>` | Restrict to a single worker. |
| `--config <path>` | Use a non-default config file. |

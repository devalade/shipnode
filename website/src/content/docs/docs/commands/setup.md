---
title: shipnode setup
description: One-time server provision — install Node.js, PM2, Caddy, and the package manager.
---

Installs everything ShipNode needs on the remote server. Idempotent — safe to re-run.

```bash
npx shipnode setup
```

Installs (Ubuntu/Debian):

- **mise** + Node.js (version from `nodeVersion`)
- **PM2** (process supervisor) + the `pm2-logrotate` module
- **Caddy** (reverse proxy + HTTPS)
- The selected package manager (npm / pnpm / yarn / bun)

## Options

| Flag | Purpose |
|---|---|
| `--config <path>` | Use a non-default config file. |

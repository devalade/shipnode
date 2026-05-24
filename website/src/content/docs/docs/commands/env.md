---
title: shipnode env
description: Upload a local .env file to the server's shared directory.
---

```bash
npx shipnode env
npx shipnode env --file .env.production
```

The file lands at `<deployPath>/shared/.env` and is symlinked into each release. PM2 picks up changes on the next `shipnode restart` or `shipnode deploy` (both use `--update-env`).

## Options

| Flag | Purpose |
|---|---|
| `--file <path>` | Local file to upload. Defaults to the `.env` referenced by `shipnode.config.ts`. |
| `--config <path>` | Use a non-default config file. |

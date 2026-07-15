---
title: shipnode env
description: Upload a local .env file to the server's shared directory.
---

```bash
npx shipnode env
npx shipnode env --file .env.production
npx shipnode env --app api --file .env.production --no-reload
```

The file lands at `<deployPath>/<app>/shared/<envFile>` and is symlinked into the current release. By default, a running PM2 app is reloaded with `--update-env`. Use `--no-reload` when the upload is immediately followed by a deployment, so old code keeps its existing process environment until the new release is ready.

## Options

| Flag | Purpose |
|---|---|
| `--file <path>` | Local file to upload. Defaults to the `.env` referenced by `shipnode.config.ts`. |
| `--app <name>` | Target a specific app. |
| `--no-reload` | Upload and link the file without reloading running PM2 processes. |
| `--config <path>` | Use a non-default config file. |

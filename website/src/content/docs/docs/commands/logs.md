---
title: shipnode logs
description: Stream PM2 logs from the server.
---

```bash
npx shipnode logs
npx shipnode logs --lines 500
npx shipnode logs --process mailer
```

## Options

| Flag | Purpose |
|---|---|
| `--lines <n>` | Number of historical lines to fetch (default `100`). |
| `--process <name>` | Restrict to a single worker (use the short name from your config). |
| `--config <path>` | Use a non-default config file. |

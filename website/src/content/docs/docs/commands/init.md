---
title: shipnode init
description: Create a shipnode.config.ts in the current project.
---

Detects the framework, package manager, app type and port. It asks only for your server's IP, an optional domain, and whether to install a database or Redis, then writes `shipnode.config.ts`. Everything else is a sensible default you can change in the file.

```bash
npx shipnode init

# or with no prompts at all
npx shipnode init --host 203.0.113.10 --domain api.example.com --non-interactive
```

## Options

| Flag | Purpose |
|---|---|
| `--host <ip>` | Server IP or hostname. |
| `--domain <domain>` | Domain to serve the app on (HTTPS is automatic). |
| `--non-interactive` | Generate config from detection, flags and defaults without prompts. |
| `--print` | Print the config to stdout instead of writing a file. |

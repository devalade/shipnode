---
title: shipnode doctor
description: Pre-flight diagnostics for local + remote configuration.
---

```bash
npx shipnode doctor
npx shipnode doctor --security
```

Runs a series of checks:

- Config validates against the schema
- SSH connectivity + sudo access on the server
- Node.js, PM2, Caddy presence and version
- Release directory permissions
- Free disk space
- Caddy is serving the configured domain

`--security` swaps in a server hardening audit instead: SSH config, firewall rules, fail2ban status, exposed ports.

## Options

| Flag | Purpose |
|---|---|
| `--security` | Run a security audit instead of standard checks. |
| `--config <path>` | Use a non-default config file. |

---
title: shipnode cloudflare
description: Cloudflare Tunnel integration — expose the app without opening ports.
---

```bash
npx shipnode cloudflare init
npx shipnode cloudflare audit
npx shipnode cloudflare status
```

| Subcommand | Purpose |
|---|---|
| `cloudflare init` | Install `cloudflared`, create the tunnel, configure DNS + Access. |
| `cloudflare audit` | Verify DNS and tunnel configuration match the app. |
| `cloudflare status` | Show the `cloudflared` service + tunnel state. |

Useful when you don't want to open ports 80/443 on the VPS. Caddy keeps doing the HTTPS termination locally; Cloudflare handles ingress. See [Cloudflare Tunnel](/docs/cloudflare/) for setup.

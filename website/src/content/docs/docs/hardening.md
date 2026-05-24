---
title: Server hardening
description: Baseline security ShipNode applies in one command.
---

```bash
npx shipnode harden
```

Applies a sensible baseline. Safe to re-run.

| Area | What it does |
|---|---|
| **SSH** | Disables password auth and root login. Only key auth. |
| **Firewall** | UFW: allow 22 / 80 / 443, deny inbound otherwise. |
| **fail2ban** | Enabled with the SSH jail (default ban window). |
| **Updates** | `unattended-upgrades` enabled for security patches. |

## Audit

```bash
npx shipnode doctor --security
```

Reports current SSH config, open ports, fail2ban status, and any drift from the baseline.

## With Cloudflare Tunnel

If you're using `shipnode cloudflare`, you can drop 80 and 443 from the firewall — only port 22 is needed inbound. Edit the UFW rules manually after running `harden`, or restrict ports 80/443 to Cloudflare IP ranges.

---
title: shipnode harden
description: Apply baseline server hardening — SSH, firewall, fail2ban.
---

```bash
npx shipnode harden
```

Idempotent. Applies:

- SSH: disable password auth, disable root login, restrict to key auth
- UFW firewall: allow 22, 80, 443; deny everything else
- fail2ban: enable with the SSH jail
- Unattended security upgrades

Pair with `shipnode doctor --security` to audit afterwards.

## Options

| Flag | Purpose |
|---|---|
| `--config <path>` | Use a non-default config file. |

---
title: shipnode eject
description: Write PM2 and Caddy templates into the project for full customization.
---

By default ShipNode renders PM2 and Caddy configuration at deploy time from internal templates. `eject` copies those templates into your repo so you can modify them.

```bash
npx shipnode eject          # eject both
npx shipnode eject pm2      # only ecosystem.config.cjs template
npx shipnode eject caddy    # only Caddyfile template
```

Once ejected, ShipNode uses the local templates on every subsequent deploy.

Templates land under `.shipnode/templates/` in your project.

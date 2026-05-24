---
title: shipnode migrate
description: Convert an existing deploy directory to the release-symlink layout.
---

If your app is already deployed in place (no `releases/` + `current` symlink), `migrate` reshapes it into the ShipNode layout so you can adopt zero-downtime deploys without a full re-deploy.

```bash
npx shipnode migrate
```

The command is non-destructive: existing files become the first release; subsequent `shipnode deploy` runs use the new layout.

## Options

| Flag | Purpose |
|---|---|
| `--config <path>` | Use a non-default config file. |

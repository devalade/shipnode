---
title: shipnode config
description: Inspect and validate the resolved configuration.
---

```bash
npx shipnode config show
npx shipnode config validate
npx shipnode config path
```

| Subcommand | Purpose |
|---|---|
| `show` | Print the resolved config (all defaults filled in). |
| `validate` | Validate the config file against the schema; non-zero exit on error. |
| `path` | Print the absolute path to the config file shipnode will load. |

Each takes `--config <path>` to target a non-default file.

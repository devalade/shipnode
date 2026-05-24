---
title: shipnode ci
description: Generate CI workflows and sync secrets.
---

```bash
npx shipnode ci github
npx shipnode ci env-sync
npx shipnode ci env-sync --all
```

| Subcommand | Purpose |
|---|---|
| `ci github` | Write a GitHub Actions workflow that runs `shipnode deploy` on push. |
| `ci env-sync` | Sync local `.env` keys into the GitHub repository secrets used by the workflow. |

`ci env-sync` prompts for each key by default. Pass `--all` to skip the confirmation and sync everything.

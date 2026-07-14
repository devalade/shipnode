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

The workflow is written at the Git repository root. When generated from a monorepo subdirectory, only the deploy step gets that `working-directory`. The generated install command pins the exact scoped Shipnode version that created the workflow; no `paths` filter is added, because root changes may affect several apps.

`ci env-sync` prompts for each key by default. Pass `--all` to skip the confirmation and sync everything.

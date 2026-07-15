---
title: shipnode ci
description: Generate CI workflows and sync secrets.
---

```bash
npx shipnode ci github
npx shipnode ci env-sync --app api --environment production --all
npx shipnode ci github --app api --environment production --sync-env
```

| Subcommand | Purpose |
|---|---|
| `ci github` | Write a GitHub Actions workflow that runs `shipnode deploy` on push. |
| `ci env-sync` | Store one complete dotenv file as an app- and environment-scoped GitHub secret. |

The workflow is written at the Git repository root. When generated from a monorepo subdirectory, only Shipnode command steps get that `working-directory`. The generated install command pins the exact scoped Shipnode version that created the workflow; no `paths` filter is added, because root changes may affect several apps.

By default, application env stays on the VPS and the workflow only requires `SHIPNODE_SSH_KEY` and `SHIPNODE_KNOWN_HOSTS`. Pass `--sync-env` to opt into GitHub-managed env for one app. `ci env-sync` preserves the file as one opaque secret, prompts once, supports `--dry-run`, and accepts `--all` to skip confirmation.

| Flag | Command | Purpose |
|---|---|---|
| `--app <name>` | Both | Target an app; required for env sync in multi-app workspaces. |
| `--config <path>` | Both | Use a non-default Shipnode config. |
| `--environment <name>` | Both | GitHub Environment, default `production`. |
| `--sync-env` | `ci github` | Materialize, upload without reload, deploy, and clean up app env. |
| `--file <path>` | `ci env-sync` | Override the app's configured env file. |
| `--dry-run` | `ci env-sync` | Show the target without changing GitHub. |
| `--all` | `ci env-sync` | Skip the single confirmation prompt. |

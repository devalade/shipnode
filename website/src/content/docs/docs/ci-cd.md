---
title: CI/CD
description: Deploy from GitHub Actions on every push to main.
---

ShipNode generates a ready-to-use GitHub Actions workflow.

```bash
npx shipnode ci github
```

This writes `.github/workflows/deploy.yml` that:

1. Checks out the repo
2. Installs deps with your package manager
3. Sets up SSH using a secret deploy key
4. Runs `npx shipnode deploy`

## Required secrets

The workflow expects the following GitHub repository secrets:

| Secret | Purpose |
|---|---|
| `SHIPNODE_SSH_KEY` | Private key for the deploy user. |
| `SHIPNODE_SSH_HOST` | Server hostname (matches `shipnode.config.ts`). |
| `SHIPNODE_ENV` | The full `.env` contents to materialize on the runner. |

Sync the env automatically:

```bash
npx shipnode ci env-sync --all
```

## Multiple environments

Duplicate the workflow file (e.g. `deploy-staging.yml`) and pass `--config shipnode.staging.config.ts` to the deploy step.

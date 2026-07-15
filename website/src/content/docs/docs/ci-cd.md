---
title: CI/CD
description: Deploy from GitHub Actions on every push to main.
---

ShipNode generates a ready-to-use GitHub Actions workflow.

```bash
npx shipnode ci github
```

This writes `.github/workflows/shipnode-deploy.yml` at the Git repository root. From a monorepo subdirectory, only the deploy step runs from that directory; root changes still trigger the workflow.

The default workflow keeps application secrets on the VPS. Upload them once from a trusted machine, then generate the workflow:

```bash
npx shipnode env --app api --file .env.production
npx shipnode ci github
```

The workflow checks out the repository, installs dependencies needed to load the config, sets up SSH, installs the exact scoped Shipnode version used to generate the file, and runs `shipnode deploy`. Shipnode itself builds frontends locally and backends remotely, so the workflow does not run a duplicate repository-root build.

Deployments use the `production` GitHub Environment by default, have read-only repository permissions, and are serialized with `cancel-in-progress: false`.

## Required secrets

The workflow expects the following GitHub repository secrets:

| Secret | Purpose |
|---|---|
| `SHIPNODE_SSH_KEY` | Private key for the deploy user. |
| `SHIPNODE_KNOWN_HOSTS` | Trusted, fingerprint-verified SSH known-hosts entry. |

Host, user, and port come from committed Shipnode configuration and are not GitHub secrets.

## GitHub-managed application env (opt-in)

Create the GitHub Environment first, then store one complete dotenv file and generate an app-specific workflow:

```bash
npx shipnode ci env-sync --app api --environment production --all
npx shipnode ci github --app api --environment production --sync-env
```

The secret is named `SHIPNODE_ENV_PRODUCTION_API`. During a deployment, the workflow:

1. Fails before deployment if the environment secret is missing.
2. Writes the complete file with mode `0600` semantics.
3. Uploads it with `shipnode env --no-reload`, so old code is not restarted with new configuration.
4. Deploys the targeted app.
5. Removes the runner copy even when deployment fails.

The dotenv file is preserved as one opaque value; Shipnode does not trim, parse, or partially update its keys. GitHub secrets are limited to 48 KB. Larger environments should remain server-managed or use an external secret store.

## Multiple environments

Generate separate workflow files for staging and production, using the matching config, app, and GitHub Environment. Rename the first generated workflow before generating the second because `ci github` writes the canonical `shipnode-deploy.yml` filename.

```bash
npx shipnode ci github --config shipnode.staging.config.ts --app api --environment staging --sync-env
```

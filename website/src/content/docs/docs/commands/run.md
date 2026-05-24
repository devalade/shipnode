---
title: shipnode run
description: Execute a one-off command on the server inside the current release.
---

```bash
npx shipnode run "node scripts/migrate.js"
npx shipnode run "npm run db:seed"
npx shipnode run --tty "bash"
```

Runs from the `current` release directory with the deployment's environment loaded. Quote the command so it's passed as a single argument. Useful for database migrations, ad-hoc scripts, and interactive shells.

## Aliases

If your `shipnode.config.ts` defines `.aliases({ ... })`, the first word of the command is matched against the alias map and expanded. Anything after it is appended.

```ts
.aliases({ migrate: 'pnpm prisma migrate deploy' })
```

```bash
npx shipnode run "migrate"
# expands to: pnpm prisma migrate deploy

npx shipnode run "migrate --create-only"
# expands to: pnpm prisma migrate deploy --create-only
```

See [Configuration → Aliases](/docs/configuration/#aliases).

## Options

| Flag | Purpose |
|---|---|
| `--tty` | Force interactive TTY mode (for shells / REPLs). |
| `--config <path>` | Use a non-default config file. |

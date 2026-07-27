---
title: shipnode deploy
description: Build, sync, release, health-check.
---

The main command. Builds the app, rsyncs it to a new timestamped release directory, installs deps on the server, flips the `current` symlink atomically, reloads PM2 with `--update-env`, and health-checks the new release.

```bash
npx shipnode deploy
```

If the health check fails, the symlink stays on the previous release and the failed release is discarded.

## Options

| Flag | Purpose |
|---|---|
| `--dry-run` | Print what would happen without changing anything on the server. |
| `--skip-build` | Skip the local `build` step (use existing build output). |
| `--watch` | Deploy once, then sync and reload on every local file change. |
| `--build <where>` | Watch mode only: where each cycle builds — `remote`, `local`, or `none`. |
| `--app <name>` | Deploy one app from a multi-app workspace instead of all of them. |
| `--config <path>` | Deploy a non-default environment, e.g. `--config shipnode.staging.config.ts`. |

## Watch mode

`--watch` turns deploy into a development loop. It runs one normal deploy to
establish a baseline, then watches your working tree: every save is rsynced
into the release that is already running, rebuilt, and reloaded.

```bash
npx shipnode deploy --watch
npx shipnode deploy --watch --app api    # required in a multi-app workspace
```

Each cycle syncs only what changed. Instead of scanning your whole tree, rsync
is handed the exact list of changed files, so a one-file edit is a one-file
transfer. Dependencies are only reinstalled when a manifest or lockfile
changes, and the health probe uses a tight backoff rather than the deploy
path's fixed delays. Directories listed in `.shipnodeignore` don't wake the
watcher, so you never pay for a cycle that would transfer nothing.

### Where the build runs

`--build` decides that, and it also decides whether build output is watched.

| Mode | Cycle does | Watches build output? |
|---|---|---|
| `remote` (backend default) | sync source → build on server → reload | No — nothing local to watch |
| `local` | build here → sync source *and* output → reload | No — shipnode writes it |
| `none` (implied by `--skip-build`) | sync → reload | Yes — it's the only signal |

The rule is: build output is watched only when shipnode is not the thing
writing it. Under `local`, watching output would feed each cycle's own build
back in and rebuild forever. Output is still *shipped* under `local` — watching
and syncing are different things, and that mode syncs by full-tree rsync so the
fresh artifact is detected without the watcher's help.

Pick `local` or `none` if you build locally and upload the artifact — Nitro,
TanStack Start, Nuxt and similar apps that deploy with `--skip-build`. Leaving
these on `remote` would ignore `.output/` and sync source the app never runs.
`none` is the one to pair with your framework's own watcher:

```bash
# terminal 1
pnpm --filter @app/qr build --watch
# terminal 2
npx shipnode deploy --watch --app qr --build none
```

In a monorepo the local build runs from the app's `appRoot`, matching where the
remote build's `package.json` lookup lands.

Watch mode deliberately skips the release pipeline, and that trade-off is worth
understanding:

- **It patches the live release.** There is no new release directory and no
  rollback target — the previous code is overwritten in place.
- **Reload restarts fork-mode processes**, so in-flight requests can drop.
- **Deletes do not propagate.** A file you delete locally stays on the server
  until the next full `shipnode deploy` builds a fresh release directory.
- **Blue-green apps reload only the colour serving traffic.** The idle colour is
  left untouched so it remains a valid rollback target.

Use it while developing against a staging box. Use plain `shipnode deploy` for
anything you need to be able to roll back.

## Release layout

```
/var/www/api/
  current -> releases/20260524160000
  releases/
    20260524150000/
    20260524160000/
  shared/
    .env
    ecosystem.config.cjs
  .shipnode/
    releases.json
    deploy.lock
```

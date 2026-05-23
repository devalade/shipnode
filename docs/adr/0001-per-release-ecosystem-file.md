# Per-release PM2 ecosystem file

The PM2 ecosystem file describes which processes constitute a deployed app (web + workers). It used to live at `/remotePath/shared/ecosystem.config.cjs` — shared across releases — which was fine when the ecosystem was effectively constant. Once apps can declare arbitrary workers, the ecosystem becomes part of the application's shape and can differ from one release to the next.

We write the ecosystem into `<releasePath>/ecosystem.config.cjs` instead, and PM2 commands target `<remotePath>/current/ecosystem.config.cjs` (stable across rollbacks because the `current` symlink always points at the active release). Rollback then restores the symlink *and*, transparently, the ecosystem that matches that release's code — a worker added in v2 won't crash-loop after rolling back to v1.

The alternative was snapshotting the shared ecosystem inside `ReleaseManager` metadata and restoring it on rollback. That works but invents a new "ecosystem snapshot" concept parallel to the existing release boundary, when the release boundary already means exactly this.

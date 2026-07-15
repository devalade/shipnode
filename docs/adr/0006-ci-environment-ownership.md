# Keep runtime env on the VPS by default; make GitHub ownership explicit

Shipnode deployments need application configuration during remote backend builds and process startup. Static frontend builds may need the same configuration on the CI runner. Treating every dotenv key as an independent repository secret created partial-update risks, lost dotenv syntax, secret-name collisions between apps, and a workflow that did not actually consume the synchronized values.

## Decision

Runtime env remains server-managed by default. Operators upload it directly with `shipnode env`; ordinary generated workflows deploy code without transferring application secrets through GitHub.

GitHub-managed env is an explicit per-app, per-environment mode:

- `ci env-sync` stores the complete dotenv file as one GitHub Environment secret named `SHIPNODE_ENV_<ENVIRONMENT>_<APP>`.
- The secret value is sent to `gh secret set` over standard input, never as a process argument.
- `ci github --sync-env` requires an app target in multi-app workspaces and generates a job bound to the selected GitHub Environment.
- The workflow rejects a missing secret, materializes the configured file under a restrictive umask, uploads it with `shipnode env --no-reload`, deploys the app, and removes the runner copy with `if: always()`.
- Files larger than GitHub's 48 KB secret limit are rejected before invoking GitHub.

SSH host, user, and port stay in committed Shipnode configuration. CI secrets are limited to the SSH private key, a trusted known-hosts entry, and the optional app environment blob.

## Deployment behavior

Uploading with `--no-reload` is required for release safety. A running old process retains its existing process environment while the new blue-green colour starts with the newly uploaded shared env. Health checks and the Caddy switch still decide whether the release goes live.

Generated workflows do not run a generic repository-root build. Frontend strategies already build locally during `shipnode deploy`, while backend strategies build remotely after sourcing the shared env. The workflow only installs dependencies needed to load project configuration and execute Shipnode.

Production jobs use GitHub Environment protection, least-privilege repository permissions, a timeout, and serialized concurrency with `cancel-in-progress: false`. Root-level monorepo changes continue to trigger deployments; no `paths` filter is generated.

## Trade-offs

- Server-managed env minimizes secret exposure but requires an out-of-band env upload or rotation step.
- GitHub-managed env makes CI reproducible but exposes the complete application environment to GitHub and its ephemeral runner.
- One opaque secret provides atomic file replacement and exact dotenv preservation, but GitHub cannot rotate or audit individual keys independently.
- Environments larger than 48 KB need to remain server-managed or move to an external secret manager; Shipnode does not introduce an encrypted-file format.

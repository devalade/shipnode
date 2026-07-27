# Changelog

All notable changes to `@devalade/shipnode` will be documented here.

## [Unreleased]

### Added
- **Fleet mode — one app on N servers behind your load balancer.** An `on` target resolving to more than one server makes the app a fleet: `shipnode deploy` rolls through its replicas a batch at a time, draining each out of rotation before touching it. Blue-green stays intra-replica, so the composition is blue-green within a replica, rolling across replicas. See [ADR-0007](docs/adr/0007-fleet-replication.md).
  - **Shipnode does not manage the load balancer.** You provision it (Hetzner, DigitalOcean, ALB, nginx); shipnode owns one readiness endpoint per replica, `/_shipnode/ready`, which answers `200` normally and `503` while that replica deploys. Point your LB's health check at it. No provider APIs, no credentials — SSH remains the only requirement.
  - **`fleet.drainWait` (default 30s) is the setting that matters.** Shipnode drains instantly; your LB only notices on its next health check, after its failure threshold. Shipnode can see neither, so you declare the wait. Below your LB's *interval × unhealthy-threshold* and the roll drops requests.
  - Draining is a sentinel file matched by Caddy, not a config rewrite: one `touch`, no reload, immediate, and it survives a Caddy or host restart — so a replica drained by a failed roll stays drained rather than quietly rejoining the pool.
  - Fleet replicas serve plain HTTP on `privateHost:fleet.port` and never claim the app's domain. Five replicas all requesting a certificate for one name would race Let's Encrypt. **TLS terminates at your load balancer**; pass-through TLS is out of scope.
  - `.group(name, servers)` names a set of servers; `on` accepts a server, a group, or a list of either. Every fleet member must declare `privateHost`.
  - A failed roll stops and reports the mixed-version fleet rather than claiming success. Updated replicas keep serving the new release, untouched ones the old, batch-mates drained but never touched go back into rotation, and **the failed replica stays drained** — out of rotation and inspectable as it died.
  - One release id for the whole roll, so `shipnode status` can distinguish a converged fleet from a half-rolled one.
- **`.beforeFleet()` / `.afterFleet()` — hooks that run once per roll**, on the first replica and the last, at the same lifecycle points as `preDeploy`/`postDeploy`. `preDeploy` runs once *per replica*, so a migration there runs three times on a three-server fleet; `beforeFleet` is where migrations belong. `beforeFleet` lands while the old code still serves (expand), `afterFleet` once every replica is updated (contract). A roll that fails partway never reaches `afterFleet`. Deploy and `--dry-run` warn when a fleet app declares `preDeploy`.
- **`placement: 'primary'` on a pm2 app** pins a process to the first server the app is declared on — crons and schedulers, where N replicas means every job fires N times. Primary is a property of the *server*, not the roll, so `deploy --on web-b` cannot promote a secondary and start a second scheduler. Rejected on a pm2 app with a port: the LB would keep routing to replicas serving nothing.
- **`SHIPNODE_<ACCESSORY>_HOST` for cross-server accessories.** Docker networks are host-local, so no connection string was ever generated and the shipnode default of `localhost` silently pointed at nothing once the database moved to its own box. Every app is now handed the address of each accessory it `dependsOn` — `127.0.0.1` when co-located, the host's `privateHost` when not — so moving an accessory to its own server is a config change, not a code change. Declared env wins.
- **`shipnode drain` / `shipnode undrain`** for manual rotation control: take a replica out without deploying it, or return one that a failed roll left behind.
- **`--on <server>`** on `deploy`, `rollback`, `harden`, `status`, `logs`, and `env`.
- **`shipnode status` reports fleet convergence** — each replica's release and rotation state, and an explicit warning naming which replicas are on which release when they disagree. A replica with no release, or one left drained, counts as not converged. Skipped under `--on`, where one observation proves nothing about the others.
- **`shipnode deploy --watch` — the development loop.** Runs one normal deploy to establish a baseline, then watches the working tree: every save is rsynced into the live release, rebuilt, reloaded, and health-probed. Each cycle is incremental — rsync receives an explicit `--files-from` list of changed paths instead of scanning the whole tree, dependencies are reinstalled only when a manifest or lockfile changes, and the health probe uses exponential backoff (100ms → 1s) rather than the deploy path's fixed 3s delay plus 2s retry gaps. Falls back to a full-tree sync when a change set is large or contains a delete, which `--files-from` cannot express. Requires `--app <name>` in a multi-app workspace; mutually exclusive with `--dry-run`.
  - This is deliberately not a release: it patches the release that is already serving, so there is no rollback target, reload can drop in-flight requests, and local deletes do not propagate until the next full deploy. Watch mode says so on startup.
  - Blue-green apps reload only the colour serving traffic (via that release's `ecosystem.web.config.cjs`), leaving the idle colour untouched so it remains a valid rollback target.
  - The deploy lock is held for each cycle, so a concurrent `shipnode deploy` can never interleave with a sync — it is skipped with a notice instead.
  - **`--build <remote|local|none>`** controls where each cycle builds. `remote` (backend default) builds on the server. `local` builds here (from `appRoot` in a monorepo) and ships the artifact. `none` (implied by `--skip-build`) only syncs and reloads, which is what pairs with a framework's own watch mode. Projects that build locally and upload the bundle — Nitro/TanStack Start/Nuxt apps deployed with `--skip-build` — need `local` or `none`; on `remote` their `.output/` is ignored and the loop would ship source the app never runs.
  - The watcher is suppressed while a build shipnode runs is writing. Ignoring build *directories* is not sufficient: a TanStack Start/Nitro build regenerates files inside the source tree (`routeTree.gen.ts`) and drops temp files at the repo root, which are indistinguishable from a developer's edit by path alone. Left unguarded this feeds each cycle back into itself — observed in the wild as a `pm2 reload` of the live process every ~8 seconds. Gating on *when* we build fixes it for any framework's codegen.
  - Build output is watched only when shipnode is not the thing writing it (`none`). Under `local` the cycle runs the build itself, so watching its output would feed those writes back in and rebuild forever; that mode instead syncs by full-tree rsync, which detects the fresh artifact without the watcher reporting it.
  - The watcher reads `.shipnodeignore` and skips those directories, so a build cache like `.nitro/` no longer costs a full lock/sync/reload/probe cycle to transfer nothing.
  - Ctrl-C during a cycle releases the deploy lock instead of leaking it. Exiting straight from the signal handler skipped the `finally` that releases it, leaving a lock no process owned and blocking every later deploy until someone ran `shipnode unlock`. A second Ctrl-C still exits immediately.
  - The debounce has a max-wait ceiling (2s). A plain debounce resets on every event, so in a repo with a background writer — a turbo daemon, a framework's own watcher — changes would sit unemitted for as long as the writing continued, and the loop would appear hung.

### Fixed
- **Postgres and Redis were installed on every server.** `database` and `redis` are workspace-level and had no `on` target, and the per-server config spread the whole workspace, so `shipnode setup` on a three-server workspace installed and initialised Postgres three times — same user, same database name. Both now take `on` and are stripped from every other server's scoped config.
- **Cloudflare DNS clobbered other servers' domains.** `cloudflare init` iterated the whole workspace app list rather than the apps on the connected host, so whichever server ran it last repointed *every* domain at *its* tunnel — including apps living elsewhere, which then 404'd through the catch-all. DNS and ingress are now scoped to the apps actually on that host.
- **Accessories could start after the apps that need them.** Servers were walked in `Object.entries(config.servers)` order and each started only its own accessories, so with the app server declared first the run was: deploy `api` → health-check `api` → *then* start Postgres. The first deploy failed, and reordering the `servers` literal silently fixed it. Servers are now traversed in dependency order derived from `dependsOn`, and the cross-server warning moved from `--dry-run` into the real deploy path. A dependency cycle falls back to declaration order rather than throwing.
- **One server failing aborted the rest.** `runRemoteCommandForTargets` had its `try/catch` outside the loop, so server 2 failing skipped server 3 and left the user with N-1 "Done" banners, one error, and no statement of which servers succeeded. Failures are now isolated per server, collected, summarised, and exit non-zero. `--app` also filters the target loop instead of only validating, so an unrelated server's connection failure no longer kills an app-scoped command.
- **`rollback` only rolled back one server.** It went through a single-connection runner, so on a three-replica fleet it restored one server and left the other two on the bad release. It now drives the same roller a deploy uses, and its confirmation is asked once up front rather than inside the loop — where the second prompt would have arrived with half the fleet already rolled back.
- **`harden` only hardened the first server**, and its seven prompts sat inside the connection, so fanning out would have asked each question once per server with earlier servers already changed. The answers are collected up front and applied to every server; it also takes `--on`.
- **`shipnode deploy --dry-run --app <name>` hid cross-server dependency warnings.** It resolved them against the app-scoped config, which no longer contains the accessory's server — so the preview was quietest exactly when the dependency was remote. The real deploy path was already correct.
- **The generated CI workflow assumed one server** — one key, one `known_hosts` entry. A host missing from `known_hosts` surfaced as an SSH failure partway through a roll, with earlier replicas already updated and the failing one left drained. The workflow now verifies every replica is a known host before deploying and prints the exact `ssh-keyscan` command to fix it.
- **An accessory published only on loopback but consumed from another server** is now a config error rather than a runtime connection failure: no connection string can reach `127.0.0.1` on another machine.
- **SSH keepalives on long-lived sessions** — `deploy --watch` and `monitor` sit idle between commands, where a NAT or firewall timeout would silently drop the connection and fail the next exec. Connections now send keepalives every 15s, and `connect` starts from a fresh client so reconnecting doesn't accumulate listeners.
- **`.env` symlinks survive a rebuild** — the build-output symlink logic moved to `envSymlinkCommand` and now re-runs after every hot-sync build, since a build that wipes and recreates its output directory takes the symlink with it. The initial deploy path is unchanged.

## [3.2.0-alpha.0] - 2026-07-11

### Added
- **Blue-green (zero-downtime) releases** — opt a backend web app in with `.zeroDowntime(altPort?)`. The new release boots on the idle colour's port while the old colour keeps serving; the health check runs against the new colour, and only on success does Caddy's upstream flip via a graceful `systemctl reload caddy` (drains in-flight requests, drops nothing). A failed health check leaves the old colour serving untouched — zero user impact on a bad release. Rollback becomes an instant Caddy flip back to the still-running previous colour (no restart). Off by default; the recreate path is unchanged. Blue = the web app's `port`, green = `altPort` (default `port + 1`). Web app runs ~2× (both colours resident between deploys); workers stay a single reloaded set. See ADR-0005.

### Fixed
- **Blue-green workers wait for health** — workers reload only after the new colour passes health (and before the Caddy flip), so a bad release no longer leaves workers on new code while traffic stays on the old colour.
- **Failed deploys revert `current` and record history** — on failure after the symlink switch, `current` is restored to the previous release (when one exists) and a `status: 'failed'` entry is written to `releases.json`.
- **Atomic deploy lock** — lock acquisition uses `mkdir` (create-or-fail) instead of a TOCTOU file check. Path is still `.shipnode/deploy.lock` (now a directory); `unlock` / monitor handle both directory and legacy file shapes.

## [3.1.0] - 2026-07-02

First real production run of 3.0 surfaced a batch of bugs — all fixed — plus one new feature (incremental restic backups to Cloudflare R2 / any S3-compatible store).

### Added
- **Incremental backup strategy via restic** — new `BackupConfig.strategy: 'snapshot' | 'restic'` (default `'snapshot'` for back-compat). The restic path streams `pg_dump` straight into a restic repository on S3-compatible storage (Cloudflare R2 in practice — set `s3Endpoint` to `https://<account-id>.r2.cloudflarestorage.com`), giving block-level dedup, client-side encryption, and 1–5% incremental daily deltas.
  - `setup` reads `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` from the local env, generates a `RESTIC_PASSWORD` if absent (and prints it — save it), installs restic via apt, writes `/etc/shipnode/backup.env` (root:root 600) + script + systemd unit+timer.
  - `backup run` goes through `systemctl start --wait` so the `EnvironmentFile` is honored (a bare script exec wouldn't source it under a non-root deploy user).
  - `backup list` uses `restic snapshots --compact` for the restic strategy.
  - New `backup restore [snapshot]` command — extracts a snapshot (or `latest`) to `--target <path>` with `--tag`/`--host` filters. Files are extracted, never applied — the actual recovery (`psql -f db.sql`, `rsync -a shared/`) stays a manual step so a bad restore can't silently trash production.
  - Retention knobs: `keepDaily` (default 7), `keepWeekly` (4), `keepMonthly` (6), enforced by `restic forget --prune`.
- **`shipnode user add <name> [--key <path>] [--sudo] [--no-sync]`** — write/update `.shipnode/users.yml` and sync the user to the server in one step, removing the manual YAML editing that `user sync` previously required.
- **`setup` bootstraps a `deploy` user** — first-run setup creates a `deploy` user (sudo, keyed off `${ssh.identityFile}.pub`) with `NOPASSWD:ALL` sudo, registers it in `.shipnode/users.yml`, and chowns `remotePath` to it. Opt out with `--no-deploy-user`. Downstream `harden` and `deploy` runs land on a non-root account instead of root. Installs mise/node/pm2 into the deploy user's home so `pm2-<user>.service` matches. `pm2 startup` runs as root but targets the deploy user; `pm2 save` runs as deploy so `dump.pm2` is the one systemd resurrects at boot.
- **PM2 boot-resurrection section in `harden`** — verifies `pm2-${ssh.user}.service` is installed, offers to refresh its dump (`pm2 save`), and offers to disable stale `pm2-*.service` units left over from a prior root-scoped setup after switching `ssh.user`.
- **`config show --app <name>`** — filter the resolved config to a single app in a multi-app workspace.

### Changed
- **`cloudflare init` uses the Cloudflare REST API for tunnel creation.** Previously relied on `cloudflared tunnel create` and `cloudflared tunnel route dns`, both of which require the browser-based `cloudflared tunnel login` flow (writes `~/.cloudflared/cert.pem`) — not scriptable. `CloudflareApi` gains `getAccountId`, `findTunnel`, `createTunnel`, and `upsertDnsRecord`; the orchestrator finds-or-creates the tunnel via API with a caller-generated secret, writes the credentials JSON at `/etc/cloudflared/<id>.json`, upserts CNAME records pointing at `<id>.cfargotunnel.com`, and enables/restarts the systemd unit. Reusing a tunnel by name now requires its credentials file to already be on the host (Cloudflare doesn't echo the secret back on GET) — error message points at the fix.
- **`cloudflared` install falls back to the upstream `.deb` from GitHub** when `pkg.cloudflare.com` has no package for the current codename (fresh Ubuntu releases like 26.04/`resolute` lag behind). Stale apt sources entry is cleaned up on fallback so `apt update` stops erroring.
- **`config show` / `deploy --dry-run` render every app in the workspace** instead of just `apps[0]`. `config show` gained `--app <name>` to narrow. Dry-run splits output into a workspace header + per-app plan block with namespace-prefixed PM2 names so the preview matches what actually ships.
- **`shipnode --version`** now reads from `package.json` at runtime instead of a hardcoded `'2.0.0'` string.

### Fixed
- **`asUser` produced broken `-u deploy bash …` under root SSH.** The `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; $SUDO -u …` idiom reduced to a bare `-u` command when EUID was 0. Switched to unconditional `sudo -u` (transparent under root, no password prompt).
- **`pm2 startup` targeted an invalid shim.** `~/.local/share/mise/shims/pm2` fails with "not a valid shim" because mise only shims tools it manages itself, not npm-installed globals. Resolve pm2's real path via `mise exec node@X -- which pm2` under the deploy user, then invoke it with `env PATH=<node-bin-dir>:$PATH`.
- **Bootstrapped `deploy` user needed NOPASSWD sudo.** `syncUsers` put the user in the `sudo` group but sudo still prompted for a password, so `harden` / `deploy` runs as deploy would hang. Setup now drops a `/etc/sudoers.d/shipnode-deploy` NOPASSWD file right after user creation.
- **`env` command silently uploaded nothing for nested `envFile` paths.** For `apps/backend/.env.production` in a monorepo, `mkdir -p ${appPath}/shared` didn't create `shared/apps/backend/`, so the `echo | base64 -d > ${sharedEnv}` redirect failed silently. The CLI still printed "Uploaded to …" (executor.exec doesn't check exit codes), and the symlink was created pointing at a non-existent file — the next deploy broke with an obscure `./.env` sourcing error. Now uses `execOrThrow` on each step and mkdirs the actual parent of `sharedEnv` via `dirname`.
- **`CaddyService` wrote `/etc/caddy/conf.d/<app>.caddy` and reloaded Caddy without sudo.** Worked when SSH user was root, broke as the deploy user with `Permission denied`. Both the write (via `| sudo tee`) and the reload (via `sudo systemctl`) go through sudo now.
- **`HealthCheckService` built PM2 names from the workspace-level `deploymentName`** (always `apps[0]`'s namespace), so in a multi-app workspace it looked up e.g. `biormin-biormin-frontend` when PM2 actually runs `biormin-frontend` under its own namespace. Every app's check now derives the namespace from that app.
- **Restic env cache missed across runs.** Restic warned `neither $XDG_CACHE_HOME nor $HOME are defined` under systemd's minimal env and re-fetched the R2 index each daily run. `HOME='/root'` is now injected via the backup env file so `/root/.cache/restic` persists.

### Notes
- The restic strategy is opt-in — existing snapshot backups keep working unchanged. Migrate by setting `strategy: 'restic'` in the `.backup(...)` block, exporting AWS credentials, and re-running `shipnode backup setup`.

## [3.0.0] - 2026-07-01

### Added
- **Multi-app workspaces** — a single `shipnode.config.ts` can now declare multiple applications deployed to the same server, each with its own domain, PM2 process set, health check, env file, build steps, and hooks:
  - New `shipnode.app()` (and the standalone `app()` factory exported from the package) returns a per-app sub-builder with the per-app methods (`.backend()`/`.frontend()`, `.name()`, `.appRoot()`, `.domain()`, `.port()`, `.pm2()`, `.worker()`, `.envFile()`, `.healthCheck()`, `.preDeploy()`/`.postDeploy()`, etc.).
  - New `.apps([api, web])` builder method on the workspace builder to compose multiple apps into one deployment.
  - Each app gets its own release directory (`<remotePath>/<app-name>/releases/<ts>/`), own Caddy site block, own PM2 ecosystem, and own lock file.
  - Orchestrator iterates over all apps, selecting the right strategy per-app (backend/frontend).
- **`--app <name>` CLI flag** — target a single app in a multi-app workspace (`shipnode deploy --app api`, `shipnode logs --app web`). Commands without `--app` apply to all apps. `rollback` requires `--app`.
- **`getActiveApp(config, name?)` workspace helper** — selects the right app by name or returns `apps[0]` when called without a name.
- **`domain/cloudflare/` domain model** — `Tunnel` class with typed `Ingress` entries, `toYaml()`/`fromYaml()` serialization, and sorted hostname output for stable, diffable configs.
- **Multi-hostname tunnel** — `cloudflare init` now enumerates all workspace apps with `domain` + web port and creates one ingress entry per app, with automatic DNS routing.

### Changed
- **Config shape split: workspace-level vs. per-app fields.** Workspace-level (`remotePath`, `ssh`, `pkgManager`, `aliases`, `nodeVersion`, etc.) stays on the root config. Per-app fields (`domain`, `pm2`, `healthCheck`, `envFile`, `keepReleases`, `buildDir`, `appRoot`, `sharedDirs`, `sharedFiles`, `hooks`) moved into `apps[]`.
  - Legacy top-level input fields are still accepted and synthesized onto `apps[0]` via `z.preprocess` — backward compatible.
- **Schema-based assembly** — `assembleConfig` no longer enumerates every field manually. The zod schema is the single source of truth; assembly normalizes legacy input and calls `ShipnodeConfigSchema.parse()`. Prevents drift between builder, schema, and assembly (fixes the pattern that dropped `.aliases()` in 2.5.1).
- **`BuilderState` is now a standalone type** with workspace-level and legacy input fields, no longer derives from `ShipnodeConfig` (which no longer has those legacy mirrors).
- **CLI commands are now thin adapters** — `cli/commands/` files are under 80 lines (cloudflare went from 249→49). Business logic extracted to `services/*-orchestrator.ts` and I/O to `infrastructure/`.
- **`cloudflare init` rewritten** — uses the `Tunnel` domain model, iterates over `config.apps` for ingress entries instead of a single `appHostname`.

### Removed
- Legacy top-level mirrors from `ShipnodeConfig` TypeScript shape:
  `config.app`, `config.pm2`, `config.domain`, `config.healthCheck`,
  `config.envFile`, `config.keepReleases`, `config.buildDir`, `config.appRoot`,
  `config.sharedDirs`, `config.sharedFiles`, `config.hooks` — read from `config.apps[i]` instead.
- **`CloudflareConfig.appHostname`** — use per-app `domain` instead. Ingress entries are now derived automatically from apps with `domain` + web port.

### Internal
- **`HooksConfigSchema` uses `z.custom<HookFn>` instead of `z.function()`** — preserves reference equality so `config.hooks.postDeploy === userFn` is true after parse.
- **Schema-coverage test** (`tests/unit/builder.test.ts`) — every builder setter is exercised in a round-trip; prevents future drift between builder, schema, and assembly.
- **`src/infrastructure/cloudflare/api.ts`** — Cloudflare API client extracted from CLI command.
- **`src/infrastructure/provisioning/commands.ts`** — database/Redis setup command builders extracted from setup command.
- **`src/infrastructure/provisioning/security.ts`** — SSH/UFW/fail2ban command builders extracted from harden command.
- **`tests/unit/cloudflare.tunnel.test.ts`** — `Tunnel.fromYaml().addIngress(...).toYaml()` round-trip tests.

## [2.5.2] - 2026-06-30

### Fixed
- **`.aliases(map)` is no longer silently dropped at config assembly.** The builder stored the map on its internal state, but the zod schema didn't declare an `aliases` field and `assembleConfig` didn't propagate it into the parsed object — so `shipnode run <name>` looked up an empty map and fell through every alias as a raw command. The schema now declares `aliases?: Record<string, string>` and the assembler forwards it. A regression test in `tests/unit/assembly.test.ts` covers the round-trip.

## [2.5.1] - 2026-05-28

### Fixed
- **`--config <relative-path>` now resolves against the user's cwd, not against shipnode's install dir.** Previously `shipnode deploy --config ./shipnode.frontend.config.ts` threw `Cannot find module './shipnode.frontend.config.ts'` because jiti's anchor is shipnode's own loader file inside `dist/`. Affected anyone using per-app configs in monorepos. Absolute paths kept working and are unchanged.

## [2.5.0] - 2026-05-28

### Fixed
- **Env vars now actually reach the app under PM2 7.x.** PM2's `env_file` option silently failed to inject variables in 7.0.x, so AdonisJS / NestJS / any framework that re-validates env at boot crashed with "Missing environment variable" after deploy. Each PM2 app is now started as `bash -c "set -a && . <shared-env> && set +a && exec <original-command>"`; the `env_file` line is gone from the generated ecosystem. Secrets stay in the chmod-600 shared env file — they're not duplicated into `ecosystem.config.cjs`. See [ADR-0003](docs/adr/0003-source-env-instead-of-pm2-env-file.md).
- **`shipnode env` upload now matches the PM2 ecosystem reference.** Upload was hardcoded to `shared/.env`, while the ecosystem referenced `shared/${envFile}`. If you set `.envFile('.env.production')` the names diverged and PM2 couldn't find the file. Upload now writes to `shared/<envFile>`; a `shared/.env` alias is also maintained so external scripts and the workDir-relative `. ./.env` keep working.
- **`.env` is auto-sourced before install, build, and `preDeploy`/`postDeploy` hooks.** Private-registry tokens referenced via `${VAR}` in `.npmrc` now resolve on the remote, and framework CLIs invoked from hooks (`node ace.js migration:run`, `nest start --watch`, etc.) see the same env vars the running app will. No more crafting bespoke `installCommand: 'set -a && ...'` snippets.

### Added
- **`.appRoot(path)` builder method** — declare a monorepo's app directory (e.g. `apps/backend`). Used for three things:
  1. Symlinks the shared `.env` into `<appRoot>/build` and `<appRoot>/dist` so frameworks like AdonisJS (whose env loader reads `.env` from the compiled app root) find it.
  2. PM2 launches the process with `cwd: <remotePath>/current/<appRoot>` — `pnpm start` now reads `<appRoot>/package.json`'s start script instead of forcing the workspace root to know about `apps/backend/build/bin/server.js`.
  3. `preDeploy` / `postDeploy` hooks run from `<workDir>/<appRoot>` — `await exec('node build/ace.js migration:run')` works without path duplication.
  
  Install and build still run from the workspace root (so workspaces/turbo/nx behave normally). When unset, shipnode also auto-scans common monorepo layouts (`apps/*/build`, `packages/*/build`, plus single-app `build`/`dist` at the repo root) for the env symlink only.

## [2.3.0] - 2026-05-24

### Added
- **Workers / multi-process deployments** — a backend can now declare additional long-running processes (workers, cron consumers, queues) alongside the web server. PM2 supervises all of them under one deployment.
  - New `.worker({ name, command, instances?, maxMemory?, env? })` builder method appends a worker to the deployment.
  - New `pm2.apps` config shape: each entry has `name`, optional `command` (custom entry like `node dist/worker.js`; defaults to `<pkgManager> start`), `port` (web app only), `instances`, `maxMemory`, `env`.
  - The entry with a `port` is the web app; entries without are workers (see [ADR-0002](docs/adr/0002-port-presence-determines-web-app.md)).
  - Worker-only deployments are legal — a backend with no web app skips the HTTP health check and Caddy site config.
  - `restart`, `stop`, `logs` accept `--process <name>` to target a single app; without it they operate on the whole deployment via the PM2 namespace.
  - Worker names are automatically prefixed with the deployment namespace when registered with PM2 (e.g. `.pm2('api')` + `.worker({name: 'mailer'})` shows up in `pm2 list` as `api` and `api-mailer`). Prevents collisions between multiple shipnode deployments on the same host. Users always refer to the short name in shipnode commands.
- **PM2 status check** — after every deploy, `pm2 jlist` is parsed and each declared app must be `online` with `restart_time === 0`. Catches workers that boot and crash before the HTTP health check would notice anything. Runs even on worker-only deployments.
- **Per-app `env`** — each `pm2.apps` entry can set its own env vars (`{ WORKER_QUEUE: 'emails' }`); PM2 loads the shared `.env` via `env_file` and applies per-app overrides on top.

### Fixed
- **Builds no longer fail because devDependencies are missing.** The default install commands for `npm`, `yarn`, and `bun` no longer pass `--production` / `--frozen-lockfile --production` — they now install everything so the subsequent build step has access to `tsc`, `vite`, `tsup`, etc. (pnpm was already fixed for this in v2.0.13; this completes the same fix for the other package managers.)

### Documentation
- README: new "Multiple environments" section showing two patterns for staging/production splits — separate `shipnode.<env>.config.ts` files driven by `--config <path>`, or a single config file switched on `SHIPNODE_ENV`. No new CLI surface; both patterns use the existing `--config` flag that every command already accepts.

### Added
- Two ways to override the server-side install command when you need flags the default doesn't carry (e.g. `'npm ci --legacy-peer-deps'`):
  - `.installCommand(cmd)` — standalone builder method.
  - `.pkgManager(pm, { installCommand: cmd })` — second-arg form, useful when you're already pinning the package manager.
  Both write to the same field. Override applies to both the initial install and the post-symlink relink; `--prefer-offline` is not appended to overridden commands.

### Changed
- **Ecosystem file is per-release** — `ecosystem.config.cjs` now lives inside each release directory instead of `<remotePath>/shared/`. PM2 references it via `<remotePath>/current/ecosystem.config.cjs` so rollback restores the exact process set that was active for that release (a worker added in v2 won't crash-loop after rolling back to v1). See [ADR-0001](docs/adr/0001-per-release-ecosystem-file.md).
- **Builder back-compat preserved** — `.pm2(name, opts)` and `.port(n)` still work and now act as sugar on the first app. Existing `shipnode.config.ts` files don't need changes.
- `shipnode config show` now lists each PM2 app with its full per-entry shape.
- `shipnode status` shows every declared app, not just the one matching the deployment name.

### Removed
- `ShipnodeConfig.backend` and the `BackendConfig` type — the port now lives on the web `pm2.apps` entry. Users of the builder/loader are unaffected; only direct consumers of the `ShipnodeConfig` TypeScript shape need to read `pm2.apps.find(a => a.port !== undefined)?.port` instead of `config.backend?.port`.
- The legacy `pm2: { name, instances, maxMemory }` object shape on `ShipnodeConfig` — same migration: read `pm2.apps[0]` instead. (The legacy *input* shape is still accepted by `assembleConfig` and folded onto `apps[0]`.)

### Migration
- **No config changes required** for existing deployments — your current `shipnode.config.ts` keeps working.
- The first deploy under this version silently cleans up any pre-existing PM2 process with the deployment's name (legacy single-app deploys), so the migration is invisible.
- To add a worker: chain `.worker({ name: 'mailer', command: 'node dist/worker.js' })` on your builder.

## [2.2.0] - 2026-05-17

### Added
- `shipnode run <alias>` — named shortcuts for remote commands, defined via `.aliases(map)` in `shipnode.config.ts`. Extra args after the alias name are appended to the expanded command. Unknown names fall through as raw strings.

### Fixed
- Deploy hooks (`.preDeploy()` / `.postDeploy()`) now correctly set up the mise PATH and `cd` into the release directory before running commands — previously `pnpm`, `npx`, etc. were not found on the remote server
- Hook `exec()` now throws on non-zero exit, aborting the deploy on failure — previously migration failures were silently swallowed
- Hook command output now streams live to the terminal as it runs, prefixed with `│` — no longer buffered and hidden

### Removed
- `.shipnode/pre-deploy.sh` and `.shipnode/post-deploy.sh` bash hook files removed from `shipnode init` — they were never executed during deploy and were misleading. Use `.preDeploy()` / `.postDeploy()` in `shipnode.config.ts` instead.

## [2.0.13] - 2026-05-16

### Added
- `shipnode env --file <path>` — upload a specific `.env` file instead of the default from config
- `shipnode init` now prompts for SSH users to add during setup, generating `.shipnode/users.yml`
- Database configuration prompts in `shipnode init` (PostgreSQL, MySQL, SQLite, MongoDB)

### Changed
- Legacy deploy mode removed — all deployments now use the release/symlink/lock flow; `.zeroDowntime()` and `.legacy()` builder methods replaced by `.keepReleases(n)`
- `shipnode deploy` now streams all remote command output (npm install, PM2 reload, etc.) prefixed with `remote:` — no longer hidden behind a spinner
- rsync transfer progress prints directly to the terminal during deploy
- CLI UI overhauled: replaced plain `console.log` output with `@clack/prompts` (spinners, notes, banners) and `listr2` task lists — all commands now render structured, coloured output
- pnpm install no longer uses `--prod` flag — installs all dependencies to prevent pnpm's `runDepsStatusCheck` from triggering a failed reinstall at PM2 startup

### Fixed
- pnpm 9+ `ERR_PNPM_IGNORED_BUILDS`: deploy now fails fast with a clear error message when native module build scripts are blocked (Prisma, bcrypt, esbuild, ssh2, etc.) instead of silently starting PM2 with broken modules and timing out on the health check; fix is to run `pnpm approve-builds` locally and commit the result
- pnpm `runDepsStatusCheck` failure at PM2 startup fixed: `pnpm install --prefer-offline` is re-run from `current/` after the symlink switch so pnpm's module resolution state matches the directory PM2 uses
- `shipnode deploy` error output is now always visible — spinner is stopped before the error propagates
- Health check failure now reads PM2 log files directly (`~/.pm2/logs/*.log`) instead of `pm2 logs --nostream` which was streaming indefinitely
- Health check adds a 2-second delay between retries
- SSH authentication: when no `identityFile` is set, connection now tries the running SSH agent (`SSH_AUTH_SOCK`) first, then falls back to default key files (`~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa`, `id_dsa`)
- SSH auth: agent and key files are now tried independently — previously an active agent socket blocked key file fallback
- PM2 ecosystem uses `exec_mode: fork` instead of `cluster` — cluster mode requires a Node.js file, not a package manager script
- PM2 ecosystem now runs `pnpm start` (or `npm start` / `yarn start` / `bun start`) instead of a hardcoded entry point file
- pnpm/yarn/bun are now installed globally on the remote server if not already present before running `install`

## [2.0.3] - 2026-05-16

### Fixed
- `shipnode init` generated config always includes SSH `port:` field (was missing)
- `shipnode init` generated config always includes `.port()` call for backend apps
- `shipnode init` generated config now includes `.build()` terminator
- `shipnode init` generated config now includes `.pkgManager()` when detected
- Restored database prompts in interactive `shipnode init` flow
- Fixed `chmod` import: now imported from `node:fs/promises` at module top level (was broken dynamic import)

## [2.0.2] - 2026-05-15

### Fixed
- `writeFile` and `readFile` imported from `node:fs/promises` instead of `fs-extra` — these are not named ESM exports in `fs-extra`

## [2.0.1] - 2026-05-15

### Fixed
- `mkdir` replaced with `ensureDir` from `fs-extra` — `mkdir` is not a named ESM export in `fs-extra`
- CI: pinned pnpm to v10 to match lockfile format and avoid pnpm v11 build approval errors
- CI: bumped Node.js to 22 in all workflows

## [2.0.0] - 2026-05-16

Complete rewrite in TypeScript with full feature parity with v1 and new capabilities.

### Added

**Core**
- Zero-downtime releases with Capistrano-style release directories and atomic symlink switch
- `shipnode init` — interactive config generator with framework auto-detection (Next.js, Remix, NestJS, Express, Fastify, AdonisJS, and more)
- `shipnode setup` — idempotent server provisioning (Node via mise, PM2, Caddy, UFW, fail2ban)
- `shipnode deploy` — full deploy with `--dry-run` and `--skip-build` flags
- `shipnode doctor` — local + remote config health check with optional `--security` audit
- `shipnode status` — PM2 process status

**Release management**
- `shipnode rollback [--steps n]` — roll back to any previous release
- `shipnode migrate` — migrate an existing in-place deploy to zero-downtime structure

**Environment**
- `shipnode env` — upload local `.env` to server shared directory
- `shipnode run <cmd>` — one-off remote command; interactive shell for `bash`/`sh` with `--tty`

**Process management**
- `shipnode logs [--lines n]` — PM2 log tail
- `shipnode restart` — PM2 reload with `--update-env`
- `shipnode stop` — stop the application
- `shipnode metrics` — interactive PM2 monit dashboard over SSH

**Security & maintenance**
- `shipnode harden` — SSH hardening, UFW firewall, fail2ban setup with confirmation prompts
- `shipnode unlock` — clear a stuck deployment lock with age display

**Users**
- `shipnode user sync` — create/update SSH users from `.shipnode/users.yml`
- `shipnode user list` — list non-system users on server
- `shipnode user remove <username>` — remove a user

**Backups**
- `shipnode backup setup` — install S3 backup script and systemd timer (hourly/daily/weekly)
- `shipnode backup run` — run a backup immediately
- `shipnode backup status` — show timer status and last run logs
- `shipnode backup list` — list recent backups in S3

**Cloudflare**
- `shipnode cloudflare init` — install cloudflared, create tunnel, configure DNS and Access
- `shipnode cloudflare audit` — verify DNS records and tunnel via Cloudflare API
- `shipnode cloudflare status` — show cloudflared service status
- Firewall lockdown to Cloudflare IPs when `lockdownFirewall: true`

**CI/CD**
- `shipnode ci github` — generate GitHub Actions deploy workflow
- `shipnode ci env-sync` — sync `.env` variables to GitHub repository secrets

**Configuration**
- `shipnode config show` — display resolved configuration
- `shipnode config validate` — validate config file with Zod
- `shipnode config path` — print config file location

**Customization**
- `shipnode eject [pm2|caddy|all]` — eject PM2/Caddy templates to `.shipnode/templates/`
- `shipnode upgrade` — self-update via npm registry

**Programmatic API**
- Fluent builder API: `shipnode.backend().ssh(...).deployTo(...).build()`
- `defineConfig()` helper for typed config files
- Deploy hooks: `.preDeploy(fn)` and `.postDeploy(fn)` with remote exec context
- Full TypeScript types exported from package root

### Fixed

- SSH identity file: was passing file path string to ssh2, now reads key content with `readFileSync`
- Deploy lock: replaced local PID check (meaningless on remote) with age-based detection (stale after 3600s)
- rsync SSH port: always passes `-e "ssh -p PORT"` — previously hardcoded port 22
- `recordRelease`: uses base64 pipe to avoid shell argument length limits on large JSON payloads
- `.shipnodeignore`: auto-detected by both backend and frontend strategies
- `assembleConfig`: was silently dropping `backup`, `cloudflare`, and `buildDir` fields

### Changed

- Package renamed from `shipnode` to `@devalade/shipnode`
- Runtime: Node.js via [mise](https://mise.jdx.dev/) instead of nvm
- Config format: TypeScript (`shipnode.config.ts`) instead of JSON/YAML
- Minimum Node.js version: 18

---

_Versions prior to 2.0.0 are tracked in the [v1 branch](https://github.com/devalade/shipnode/tree/main)._

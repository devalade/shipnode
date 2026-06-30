# Changelog

All notable changes to `@devalade/shipnode` will be documented here.

## [3.0.0] - unreleased

### Added
- **Multi-app workspaces** — a single `shipnode.config.ts` can now declare multiple applications deployed to the same server, each with its own domain, PM2 process set, health check, env file, build steps, and hooks:
  - New `.app(name, fn)` builder method to define per-app configuration inside a workspace.
  - New `.apps([api, web])` builder method to compose multiple apps into one deployment.
  - Each app gets its own release directory (`<remotePath>/<app-name>/releases/<ts>/`), own Caddy site block, own PM2 ecosystem, and own lock file.
  - Orchestrator iterates over all apps, selecting the right strategy per-app (backend/frontend).
- **`--app <name>` CLI flag** — target a single app in a multi-app workspace (`shipnode deploy --app api`, `shipnode logs --app web`). Commands without `--app` apply to all apps. `rollback` requires `--app`.
- **`getActiveApp(config, name?)` workspace helper** — selects the right app by name or returns `apps[0]` when called without a name.

### Changed
- **Config shape split: workspace-level vs. per-app fields.** Workspace-level (`remotePath`, `ssh`, `pkgManager`, `aliases`, `nodeVersion`, etc.) stays on the root config. Per-app fields (`domain`, `pm2`, `healthCheck`, `envFile`, `keepReleases`, `buildDir`, `appRoot`, `sharedDirs`, `sharedFiles`, `hooks`) moved into `apps[]`.
  - Legacy top-level input fields are still accepted and synthesized onto `apps[0]` via `z.preprocess` — backward compatible.
- **Schema-based assembly** — `assembleConfig` no longer enumerates every field manually. The zod schema is the single source of truth; assembly normalizes legacy input and calls `ShipnodeConfigSchema.parse()`. Prevents drift between builder, schema, and assembly (fixes the pattern that dropped `.aliases()` in 2.5.1).
- **`BuilderState` is now a standalone type** with workspace-level and legacy input fields, no longer derives from `ShipnodeConfig` (which no longer has those legacy mirrors).

### Removed
- Legacy top-level mirrors from `ShipnodeConfig` TypeScript shape:
  `config.app`, `config.pm2`, `config.domain`, `config.healthCheck`,
  `config.envFile`, `config.keepReleases`, `config.buildDir`, `config.appRoot`,
  `config.sharedDirs`, `config.sharedFiles`, `config.hooks` — read from `config.apps[i]` instead.

### Internal
- **`HooksConfigSchema` uses `z.custom<HookFn>` instead of `z.function()`** — preserves reference equality so `config.hooks.postDeploy === userFn` is true after parse.
- **Schema-coverage test** (`tests/unit/builder.test.ts`) — every builder setter is exercised in a round-trip; prevents future drift between builder, schema, and assembly.

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

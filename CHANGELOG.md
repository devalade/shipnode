# Changelog

All notable changes to `@devalade/shipnode` will be documented here.

## [Unreleased]

### Added
- `shipnode env --file <path>` — upload a specific `.env` file instead of the default from config
- `shipnode init` now prompts for SSH users to add during setup, generating `.shipnode/users.yml`
- Database configuration prompts in `shipnode init` (PostgreSQL, MySQL, SQLite, MongoDB)

### Changed
- `shipnode deploy` now streams all remote command output (npm install, PM2 reload, etc.) prefixed with `remote:` — no longer hidden behind a spinner
- rsync transfer progress prints directly to the terminal during deploy
- CLI UI overhauled: replaced plain `console.log` output with `@clack/prompts` (spinners, notes, banners) and `listr2` task lists — all commands now render structured, coloured output

### Fixed
- `shipnode deploy` error output is now always visible — spinner is stopped before the error propagates
- Health check failure now shows last 30 lines of PM2 logs inline so the cause of a failed start is immediately visible
- Health check adds a 2-second delay between retries
- SSH authentication: when no `identityFile` is set, connection now tries the running SSH agent (`SSH_AUTH_SOCK`) first, then falls back to default key files (`~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa`, `id_dsa`)

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

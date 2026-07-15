# shipnode v3 Reference

For the 2.x single-app API (npm `latest` / `@devalade/shipnode@2`), see [REFERENCE-v2.md](REFERENCE-v2.md).

## All commands

Most commands accept `--config <path>` and `--app <name>` (multi-app). `rollback` requires `--app` when more than one app exists.

### Core
| Command | Description |
|---|---|
| `init [--non-interactive] [--print]` | Generate shipnode.config.ts |
| `setup [--no-deploy-user]` | Install Node, PM2, Caddy, mise; bootstrap `deploy` user |
| `deploy [--dry-run] [--skip-build] [--app name]` | Deploy all apps or one |
| `doctor [--security]` | Local + remote config / security audit |
| `status [--app name]` | PM2 process status |

### Release management
| Command | Description |
|---|---|
| `rollback --app name [--steps n]` | Roll back n releases (default 1). Blue-green: one-step Caddy flip |
| `migrate` | Migrate existing deploy to release/symlink structure |

### Environment & process
| Command | Description |
|---|---|
| `env [--file path] [--app name]` | Upload .env → `<appPath>/shared/` |
| `run [cmd] [--tty] [--app name]` | One-off remote command (or alias) |
| `logs [--lines n] [--app name]` | Tail PM2 logs |
| `restart [--app name]` | Reload PM2 with `--update-env` |
| `stop [--app name]` | Stop the application |
| `metrics` | PM2 monitoring dashboard |
| `monitor [--app name]` | Live TUI (PM2, system, health, logs) |
| `unlock` | Clear stuck deploy lock (`.shipnode/deploy.lock/`) |

### Accessories & secrets
| Command | Description |
|---|---|
| `accessory status [name]` | Docker accessory status |
| `accessory logs <name>` | Accessory logs |
| `accessory restart <name>` | Restart accessory |
| `accessory stop <name>` | Stop accessory |
| `accessory health <name>` | Run accessory health check |
| `secret set <name> [value]` | Set remote secret (value or local env) |
| `registry login` | Store registry token + `docker login` on target |

### Security & maintenance
| Command | Description |
|---|---|
| `harden` | SSH hardening, UFW, fail2ban, PM2 boot check |
| `doctor --security` | Security audit |

### Users
| Command | Description |
|---|---|
| `user add <name> [--key path] [--sudo] [--no-sync]` | Write `.shipnode/users.yml` + sync |
| `user sync` | Sync users from `.shipnode/users.yml` |
| `user list` | List non-system users |
| `user remove <username>` | Remove user |

### Backup
| Command | Description |
|---|---|
| `backup setup` | Install script + systemd timer |
| `backup run` | Run immediately |
| `backup status` | Timer + last run |
| `backup list` | List S3 / restic snapshots |
| `backup restore [snapshot] --target <path>` | Extract restic snapshot (default `latest`) |

### Cloudflare
| Command | Description |
|---|---|
| `cloudflare init` | Tunnel + DNS + ingress for every app domain |
| `cloudflare audit` | Verify DNS + tunnel |
| `cloudflare status` | cloudflared service status |

### CI/CD
| Command | Description |
|---|---|
| `ci github [--app name] [--environment name] [--sync-env]` | Write the deploy workflow; app env stays server-managed unless opted in |
| `ci env-sync [--app name] [--environment name] [--file path] [--dry-run] [--all]` | Store one complete dotenv file as a GitHub Environment secret |

### Config
| Command | Description |
|---|---|
| `config show [--app name]` | Print resolved config |
| `config validate` | Validate config file |
| `config path` | Print config file path |

### Misc
| Command | Description |
|---|---|
| `eject [pm2\|caddy\|all]` | Eject templates to `.shipnode/templates/` |
| `upgrade` | Upgrade shipnode CLI |

---

## Workspace builder (root)

| Method | Default | Description |
|---|---|---|
| `.ssh({ host, user, port?, identityFile? })` | port 22 | Default SSH connection |
| `.servers({ name: SshConfig })` | — | Named server targets |
| `.cloudflareAccess(proxyCommand?)` | — | SSH via Cloudflare Access |
| `.deployTo(path)` | `/var/www/app` | Workspace remote base path |
| `.nodeVersion(v)` | `lts` | Node via mise |
| `.pkgManager(pm, { installCommand? })` | auto | `npm` \| `yarn` \| `pnpm` \| `bun` |
| `.installCommand(cmd)` | pkg default | Override remote install |
| `.database(opts)` | — | Postgres/MySQL/SQLite provisioning hints |
| `.redis(opts)` | — | Redis connection |
| `.backup(opts)` | — | S3 / restic backup config |
| `.cloudflare(opts)` | — | Tunnel zone / name / lockdown |
| `.aliases(map)` | — | Named `shipnode run` shortcuts |
| `.registry({ server, username, passwordEnv })` | — | Default Docker registry |
| `.accessories(map)` | — | Docker sidecar definitions |
| `.app()` | — | Start a per-app sub-builder |
| `.apps([appBuilders])` | — | Compose multi-app workspace (wins over top-level per-app methods) |
| `.backend()` / `.frontend()` … | — | Legacy single-app shortcuts → `apps[0]` |
| `.build()` | — | Assemble + validate → `ShipnodeConfig` |

### Backup options
```ts
.backup({
  s3Bucket: string,
  s3Prefix?: string,
  s3Endpoint?: string,          // e.g. R2
  schedule?: 'hourly' | 'daily' | 'weekly',
  retentionDays?: number,       // snapshot strategy
  strategy?: 'snapshot' | 'restic',
  keepDaily?: number,           // restic (default 7)
  keepWeekly?: number,          // default 4
  keepMonthly?: number,         // default 6
})
```

### Accessory shape
```ts
{
  image: string,
  on?: string,                  // server target name
  port?: string | string[],
  volumes?: string[],
  networks?: string[],
  command?: string | string[],
  env?: Record<string, string>,
  restart?: 'no' | 'always' | 'unless-stopped' | 'on-failure',
  registry?: { server, username, passwordEnv },
  healthCheck?: { command: string },
}
```

---

## Per-app builder (`app()` / `shipnode.app()`)

| Method | Default | Description |
|---|---|---|
| `.backend()` / `.frontend()` | — | App type (required) |
| `.name(n)` | inferred | App id → release dir + CLI `--app` |
| `.on(serverName)` | default ssh | Target from `.servers()` |
| `.appRoot(dir)` | `.` | Monorepo package path |
| `.pm2(name, { instances?, maxMemory? })` | — | Primary PM2 process |
| `.port(n)` | — | Web port (marks the HTTP app; sets `PORT`) |
| `.worker({ name, command, … })` | — | Extra PM2 process (no port) |
| `.domain(d)` | — | Caddy + Cloudflare ingress |
| `.caddy({ append })` | — | Extra Caddy directives |
| `.buildDir(dir)` | auto | Frontend output dir |
| `.envFile(f)` | `.env` | Uploaded to `shared/`, symlinked as `.env` |
| `.keepReleases(n)` | `5` | Releases to retain |
| `.zeroDowntime(altPort?)` | automatic when eligible | Force blue-green or choose the alternate port; default offset is 10,000 |
| `.noZeroDowntime()` | — | Opt out of automatic blue-green |
| `.sharedDirs(dirs)` / `.sharedFiles(files)` | — | Persist across releases |
| `.healthCheck(path, opts?)` | `/health`, 30s, 3 retries, 3s delay | Post-deploy probe |
| `.noHealthCheck()` | — | Skip health check |
| `.preDeploy(fn)` / `.postDeploy(fn)` | — | Deploy hooks |
| `.dependsOn(['accessory'])` | — | Ensure accessories before deploy |

---

## Deploy lifecycle

```
lock → accessories → per app:
  release dir → stage → setup (install/build) → preDeploy
  → symlink current → start (web colour if blue-green)
  → health → afterHealthy (workers) → Caddy flip (blue-green)
  → record success → postDeploy → cleanup
→ caddy.configureAll → unlock
```

On failure after symlink: revert `current` (if previous exists), record `failed`, unlock.

### Blue-green notes
- Requires backend + one PM2 app with `.port()`.
- Web process duplicated (`name-blue` / `name-green`); workers single set, reloaded only after health.
- State: `<appPath>/.shipnode/deploy-state.json` (port pair frozen after first deploy).
- Health failure: old colour keeps traffic; workers untouched; `current` reverted.

---

## Deploy hook API

```ts
.preDeploy(async ({ exec, config }) => { ... })
.postDeploy(async ({ exec, config }) => { ... })
```

`exec(cmd)` runs on the remote in the new release dir (or `<release>/<appRoot>`). Env file sourced when configured. Throws on non-zero exit.

---

## Run aliases

```ts
.aliases({
  migrate: 'pnpm db:apply',
  seed: 'pnpm db:seed',
})
```

```bash
shipnode run migrate
shipnode run migrate --step 2
shipnode run "echo hello"
```

---

## Paths (per app)

| Path | Purpose |
|---|---|
| `<remotePath>/<app>/releases/<ts>/` | Release snapshot |
| `<remotePath>/<app>/current` | Symlink to active release |
| `<remotePath>/<app>/shared/` | Env + shared dirs/files |
| `<remotePath>/<app>/.shipnode/releases.json` | Release history |
| `<remotePath>/<app>/.shipnode/deploy-state.json` | Blue-green colour/ports |
| `<remotePath>/.shipnode/deploy.lock/` | Workspace deploy lock (mkdir) |

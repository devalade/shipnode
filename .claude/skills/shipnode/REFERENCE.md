# shipnode Reference

## All commands

### Core
| Command | Description |
|---|---|
| `init [--non-interactive] [--print]` | Generate shipnode.config.ts |
| `setup` | Install Node, PM2, Caddy, mise on server |
| `deploy [--dry-run] [--skip-build]` | Deploy application |
| `doctor [--security]` | Check local + remote config / security audit |
| `status` | Show PM2 process status |

### Release management
| Command | Description |
|---|---|
| `rollback [--steps n]` | Roll back n releases (default: 1) |
| `migrate` | Migrate existing deploy to zero-downtime structure |

### Environment & process
| Command | Description |
|---|---|
| `env [--file path]` | Upload .env to server |
| `run [cmd] [--tty]` | Run one-off command on server |
| `logs [--lines n]` | Tail PM2 logs |
| `restart` | Reload PM2 with --update-env |
| `stop` | Stop the application |
| `metrics` | Open PM2 monitoring dashboard |
| `unlock` | Clear a stuck deployment lock |

### Security & maintenance
| Command | Description |
|---|---|
| `harden` | SSH hardening, UFW firewall, fail2ban |
| `doctor --security` | Security audit |

### Users
| Command | Description |
|---|---|
| `user sync` | Sync users from .shipnode/users.yml |
| `user list` | List non-system users |
| `user remove <username>` | Remove user |

### Backup
| Command | Description |
|---|---|
| `backup setup` | Install backup script + systemd timer |
| `backup run` | Run backup immediately |
| `backup status` | Show timer and last run log |
| `backup list` | List recent S3 backups |

### Cloudflare
| Command | Description |
|---|---|
| `cloudflare init` | Install cloudflared, create tunnel, configure DNS |
| `cloudflare audit` | Verify DNS + tunnel |
| `cloudflare status` | Show cloudflared service status |

### CI/CD
| Command | Description |
|---|---|
| `ci github` | Write .github/workflows/shipnode-deploy.yml |
| `ci env-sync [--all]` | Push .env → GitHub repo secrets |

### Config
| Command | Description |
|---|---|
| `config show` | Print resolved config |
| `config validate` | Validate config file |
| `config path` | Print config file path |

### Misc
| Command | Description |
|---|---|
| `eject [pm2\|caddy\|all]` | Eject PM2/Caddy templates to .shipnode/templates/ |
| `upgrade` | Upgrade shipnode to latest version |

All commands accept `--config <path>` to use a non-default config file.

---

## Builder DSL — all options

| Method | Default | Description |
|---|---|---|
| `.backend()` / `.frontend()` | — | App type (required) |
| `.ssh({ host, user, port?, identityFile? })` | port 22 | SSH connection |
| `.deployTo(path)` | `/var/www/app` | Remote deploy path |
| `.pm2(name, opts?)` | — | PM2 process name + options |
| `.port(n)` | `3000` | Backend listening port |
| `.domain(d)` | — | Domain for Caddy config |
| `.nodeVersion(v)` | `lts` | Node version via mise |
| `.pkgManager(pm)` | auto-detected | `npm` \| `yarn` \| `pnpm` \| `bun` |
| `.buildDir(dir)` | auto-detected | Frontend build output directory |
| `.zeroDowntime({ keepReleases? })` | true, 5 releases | Zero-downtime mode |
| `.legacy()` | — | In-place rsync deploy, no rollback |
| `.healthCheck(path, opts?)` | `/health`, 30s, 3 retries | Post-deploy check |
| `.noHealthCheck()` | — | Skip health check |
| `.envFile(f)` | `.env` | Local .env file to upload |
| `.sharedDirs(dirs)` | — | Directories persisted across releases |
| `.sharedFiles(files)` | — | Files persisted across releases |
| `.database(opts)` | — | Database connection config |
| `.backup(opts)` | — | S3 backup config |
| `.cloudflare(opts)` | — | Cloudflare Tunnel config |
| `.preDeploy(fn)` | — | Hook: before symlink switch |
| `.postDeploy(fn)` | — | Hook: after deploy |

## Deploy hook API

```ts
.preDeploy(async ({ exec, config }) => { ... })
.postDeploy(async ({ exec, config }) => { ... })
```

`exec(cmd)` runs the command on the remote server in the new release directory.

---
title: Quick start
description: Everything you need to go from an empty Ubuntu VPS to a deployed Node.js app, in about ten minutes.
---

This walkthrough covers the **full happy path** — provisioning a fresh server, generating a config, deploying your first release, rolling back, and wiring CI. Skip ahead if a section doesn't apply.

:::tip[Use the ShipNode AI skill in Claude Code]
Inside [Claude Code](https://claude.com/claude-code), the `shipnode` skill knows this CLI end-to-end — deploying, rolling back, configuring Caddy/PM2, managing `.env`, and reading server state. Type `/shipnode` in Claude Code or just describe what you want; the skill is auto-triggered when relevant. Every page on this site also has **Copy as Markdown / Open in Claude / Open in ChatGPT** buttons at the top so you can hand the docs to any AI assistant.
:::

## 0. Prerequisites

| You need | Why |
|---|---|
| **A VPS** running Ubuntu 22.04+ or Debian 12+ | ShipNode provisions Node, PM2, Caddy on this OS. |
| **A non-root SSH user** with `sudo` and a public key in `~/.ssh/authorized_keys` | All `shipnode` commands run as this user. |
| **A domain** pointing an A record at the VPS IP | Caddy will issue an HTTPS cert automatically. |
| **Node.js 18+ locally** | The CLI is a Node.js package. |

If your VPS only has a root user right now, create the deploy user first:

```bash
ssh root@your.vps.ip
adduser deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
```

## 1. Install shipnode in your project

```bash
# npm
npm install -D @devalade/shipnode

# pnpm
pnpm add -D @devalade/shipnode

# yarn
yarn add -D @devalade/shipnode

# bun
bun add -d @devalade/shipnode
```

`shipnode` lives in your project as a dev dependency so every collaborator and your CI uses the same version.

## 2. Generate the config

```bash
npx shipnode init
```

This prompts for framework, package manager, app type, SSH target, domain, and port — then writes `shipnode.config.ts`. You can rerun `init` or edit the file by hand at any time. See the [configuration reference](/docs/configuration/) for every option.

A minimal backend config:

```ts
import { shipnode } from '@devalade/shipnode';

export default shipnode
  .backend()
  .ssh({ host: '203.0.113.10', user: 'deploy' })
  .deployTo('/var/www/api')
  .pm2('api', { instances: 2 })
  .port(3000)
  .domain('api.example.com')
  .healthCheck('/health')
  .nodeVersion('22')
  .pkgManager('pnpm')
  .build();
```

## 3. Provision the server

```bash
npx shipnode setup
```

One-time, idempotent. Installs **mise**, **Node.js**, **PM2** (+ `pm2-logrotate`), **Caddy**, and your package manager. Re-running it is safe — it skips anything already present.

Verify with:

```bash
npx shipnode doctor
```

If anything is red, fix it before deploying.

## 4. Upload secrets

If your app reads from `.env`, push it once:

```bash
npx shipnode env
```

The file lands at `<deployPath>/shared/.env` and is symlinked into every release. PM2 picks up changes on the next `restart` or `deploy` (both use `--update-env`).

## 5. Deploy

```bash
npx shipnode deploy
```

What happens:

```
rsync     ./       ->  /var/www/api/releases/20260524160000
install   pnpm install --frozen-lockfile
build     pnpm run build
symlink   current  ->  releases/20260524160000
pm2       reload api --update-env
health    GET /health  200 OK  47ms
deployed  https://api.example.com
```

If the health check fails, the symlink stays on the previous release and the failed one is discarded. No partial outage.

## 6. Confirm and operate

```bash
npx shipnode status        # PM2 state + current release
npx shipnode logs          # stream logs
npx shipnode metrics       # PM2 CPU/memory dashboard
```

Need to run a one-off command on the server inside the current release?

```bash
npx shipnode run "node scripts/migrate.js"
```

## 7. Roll back

Something off in production?

```bash
npx shipnode rollback --steps 1
```

The `current` symlink moves back one release and PM2 reloads. The default `keepReleases` is 5, so you have headroom.

## 8. Wire CI (optional)

Generate a ready-to-use GitHub Actions workflow:

```bash
npx shipnode ci github
npx shipnode ci env-sync --all
```

This drops `.github/workflows/deploy.yml` and pushes your `.env` keys to GitHub repository secrets. See the [CI/CD guide](/docs/ci-cd/) for the secrets it expects.

## 9. Harden the server (recommended)

```bash
npx shipnode harden
```

Locks down SSH (key-only, no root), enables UFW, installs `fail2ban`, and turns on unattended security upgrades.

Audit it anytime:

```bash
npx shipnode doctor --security
```

## What's next

- [shipnode.config.ts reference](/docs/configuration/) — every method, every option
- [Multi-environment](/docs/environments/) — add a staging deploy
- [Workers](/docs/workers/) — long-running PM2 processes alongside the web app
- [Cloudflare Tunnel](/docs/cloudflare/) — close inbound ports entirely
- [Backups](/docs/backups/) — scheduled `pg_dump` + file backups to S3

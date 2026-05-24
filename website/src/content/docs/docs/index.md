---
title: ShipNode
description: Deploy Node.js apps to a single VPS — zero-downtime releases, PM2, Caddy, SSH, no Docker.
---

ShipNode is a CLI that deploys Node.js apps to a single VPS over SSH. No Docker, no Kubernetes, no platform lock-in.

## What it does

- **Zero-downtime releases.** Timestamped directories + atomic `current` symlink flip.
- **Process supervision.** PM2 reloads with `--update-env`, supervises workers.
- **HTTPS edge.** Caddy reverse proxy with automatic certificates.
- **Health checks + rollback.** Verifies the new release; reverts if it fails.
- **One config file.** A typed `shipnode.config.ts` per project.

## Who it's for

You have a VPS (Ubuntu or Debian), a Node.js app, and you want a real deploy workflow without rebuilding a platform from shell history.

## Next steps

- [Install](/docs/install/)
- [Quick start](/docs/quick-start/)
- [Configuration](/docs/configuration/)

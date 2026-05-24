---
title: Install
description: Install shipnode as a project-local dev dependency.
---

ShipNode installs as a project-local dev dependency. Pick your package manager:

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

## Requirements

- **Local:** Node.js >= 18
- **Server:** Ubuntu or Debian (shipnode provisions Node, PM2, Caddy, and the package manager during `shipnode setup`)
- **SSH access** to the server with a deploy user

## Verify

```bash
npx shipnode --version
```

## Upgrade

```bash
npx shipnode upgrade
```

Or just bump the dependency version in your `package.json`.

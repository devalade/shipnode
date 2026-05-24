---
title: Team users
description: Reconcile server user accounts from a YAML manifest in your repo.
---

`shipnode user sync` reads `.shipnode/users.yml` and reconciles the server's user list. Add a teammate by opening a PR, not by SSHing in.

## Manifest

```yaml
# .shipnode/users.yml
users:
  - name: alice
    sudo: true
    keys:
      - ssh-ed25519 AAAA... alice@laptop
  - name: bob
    sudo: false
    keys:
      - ssh-ed25519 AAAA... bob@laptop
      - ssh-ed25519 AAAA... bob@workstation
```

## Apply

```bash
npx shipnode user sync
```

For each user in the manifest, shipnode will:

1. Create the Linux user if missing
2. Add to `sudo` group if `sudo: true`
3. Write the public keys to `~/.ssh/authorized_keys`

Users present on the server but absent from the manifest are **not** removed automatically. Remove explicitly:

```bash
npx shipnode user remove bob
```

## Inspect

```bash
npx shipnode user list
```

Lists non-system users currently on the server.

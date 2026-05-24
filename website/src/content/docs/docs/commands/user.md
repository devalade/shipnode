---
title: shipnode user
description: Manage server users from a checked-in YAML manifest.
---

ShipNode reads `/.shipnode/users.yml` from your repo and reconciles the server's user list against it. SSH keys, sudo flags, and Linux usernames live in one file.

```bash
npx shipnode user sync
npx shipnode user list
npx shipnode user remove alice
```

## Subcommands

| Command | Purpose |
|---|---|
| `user sync` | Reconcile server users against `.shipnode/users.yml`. |
| `user list` | List non-system users on the server. |
| `user remove <name>` | Remove a user (does not delete `$HOME`). |

## `.shipnode/users.yml` example

```yaml
users:
  - name: alice
    sudo: true
    keys:
      - ssh-ed25519 AAAA... alice@laptop
  - name: bob
    sudo: false
    keys:
      - ssh-ed25519 AAAA... bob@laptop
```

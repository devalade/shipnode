---
title: shipnode backup
description: Database and file backups to S3 on a systemd timer.
---

```bash
npx shipnode backup setup
npx shipnode backup run
npx shipnode backup status
npx shipnode backup list
```

| Subcommand | Purpose |
|---|---|
| `backup setup` | Install the backup script + systemd timer on the server. |
| `backup run` | Run a backup immediately. |
| `backup status` | Show the timer state and the last run result. |
| `backup list` | List recent backups in S3. |

Configuration (S3 bucket, retention, what to back up) lives in `shipnode.config.ts` — see [Backups](/docs/backups/) for the full guide.

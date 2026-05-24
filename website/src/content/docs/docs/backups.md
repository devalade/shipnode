---
title: Backups
description: Scheduled database and file backups to S3.
---

ShipNode provisions a backup script and a `systemd` timer on the server. Backups go to any S3-compatible bucket (AWS, Cloudflare R2, Backblaze B2, MinIO).

## Configure

Add a `.backup(...)` block to your `shipnode.config.ts`:

```ts
export default shipnode
  .backend()
  .ssh({ host: '203.0.113.10', user: 'deploy' })
  .deployTo('/var/www/api')
  .pm2('api')
  .port(3000)
  .backup({
    schedule: 'daily',
    retentionDays: 30,
    s3: {
      bucket: 'my-backups',
      region: 'auto',
      endpoint: 'https://<account>.r2.cloudflarestorage.com',
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    postgres: { database: 'api_prod' },
    files: ['/var/www/api/shared/uploads'],
  })
  .build();
```

## Install + run

```bash
npx shipnode backup setup     # installs script + systemd timer
npx shipnode backup run       # run once now
npx shipnode backup status    # timer + last run
npx shipnode backup list      # list objects in the bucket
```

## What's backed up

- **Postgres** (if `postgres` is set): `pg_dump` of the named database
- **Files**: any paths listed under `files` (gzip tarball)

Each run produces one timestamped object per source. Retention is enforced server-side via S3 lifecycle rules where supported, otherwise via the backup script.

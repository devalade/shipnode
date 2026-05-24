---
title: Multi-environment
description: Drive staging and production from the same repo with separate config files.
---

ShipNode treats environments as separate config files. There is no `--profile` flag — you point `--config` at the file you want.

## Layout

```
shipnode.config.ts            # production (default)
shipnode.staging.config.ts    # staging
```

## Staging config

```ts
import { shipnode } from '@devalade/shipnode';

export default shipnode
  .backend()
  .ssh({ host: 'staging.example.com', user: 'deploy' })
  .deployTo('/var/www/api-staging')
  .pm2('api-staging', { instances: 1 })
  .port(3000)
  .domain('staging-api.example.com')
  .nodeVersion('22')
  .pkgManager('pnpm')
  .build();
```

## Run a command against staging

```bash
npx shipnode deploy --config shipnode.staging.config.ts
npx shipnode status --config shipnode.staging.config.ts
npx shipnode logs   --config shipnode.staging.config.ts
```

Every command that touches the server takes `--config`. Use it consistently or wrap it in npm scripts:

```json
{
  "scripts": {
    "deploy:staging": "shipnode deploy --config shipnode.staging.config.ts",
    "deploy:prod":    "shipnode deploy"
  }
}
```

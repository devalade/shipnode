---
title: Workers
description: Long-running PM2 processes deployed alongside the web app.
---

A backend can run additional long-running processes alongside the web server. PM2 supervises all of them under one deployment.

```ts
export default shipnode
  .backend()
  .ssh({ host: '203.0.113.10', user: 'deploy' })
  .deployTo('/var/www/api')
  .pm2('api', { instances: 2 })
  .port(3000)
  .worker({ name: 'mailer', command: 'node dist/worker.js' })
  .worker({ name: 'cron',   command: 'node dist/cron.js', env: { JOB: 'cleanup' } })
  .build();
```

## Targeting one process

By default `logs`, `restart`, `stop` operate on the whole deployment. Use `--process <name>` to target one (use the short name from your config):

```bash
npx shipnode logs    --process mailer
npx shipnode restart --process cron
```

## PM2 naming

PM2 has a flat global namespace, so two deployments with a `worker` named `mailer` on the same host would collide. ShipNode prefixes worker names with the deployment namespace when registering with PM2.

A config with `.pm2('api')` + `.worker({ name: 'mailer' })` appears in `pm2 list` as `api` and `api-mailer`. You always use the short name (`mailer`) in shipnode commands.

## Worker-only deployments

Omit `.port()` and `.domain()` to deploy a worker-only app — useful for queue consumers or cron runners:

```ts
export default shipnode
  .backend()
  .ssh({ host: '203.0.113.10', user: 'deploy' })
  .deployTo('/var/www/queue-runner')
  .worker({ name: 'jobs', command: 'node dist/worker.js' })
  .build();
```

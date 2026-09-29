---
title: wattpm runtime
description: Opt in to running the web app as worker threads sharing one port, supervised by systemd instead of PM2.
---

By default ShipNode supervises your app with PM2. The `watt` runtime is an opt-in alternative: the web app runs under [wattpm](https://docs.platformatic.dev/) as **worker threads in one process**, each accepting connections straight from the kernel via `SO_REUSEPORT`. There is no supervisor process handing connections to workers, and V8's startup state is not duplicated per worker.

```ts
export default shipnode
  .backend()
  .ssh({ host: '203.0.113.10', user: 'deploy' })
  .deployTo('/var/www/api')
  .pm2('api', { instances: 4, maxMemory: '512M' }) // instances = worker threads
  .port(3000)
  .domain('api.example.com')
  .runtime('watt', { main: 'dist/server.js' })
  .worker({ name: 'mailer', command: 'node dist/worker.js' })
  .build();
```

## Requirements

- Add `wattpm` and `@platformatic/node` to your app's dependencies. Deploy stops with the install command if they are missing.
- `main` is the file each worker thread loads. It must start an HTTP server on `process.env.PORT`.
- Scaling past one thread needs **Linux**. Elsewhere wattpm forces a single worker for the web app.

## What changes

| | PM2 (default) | `watt` |
|---|---|---|
| Web app | PM2 process(es) | wattpm worker threads, `instances` of them |
| Workers | PM2 processes | one systemd unit each |
| Supervision | PM2 + `pm2 startup` | systemd units named `shipnode-<app>[-<colour>]` |
| Zero-downtime | blue-green | blue-green (each colour is its own unit) |
| `shipnode restart` | rolling `pm2 reload` | in-place `systemctl restart` |

Everything else — `deploy`, `rollback`, `logs`, `stop`, `env`, `status`, `deploy --watch`, the monitor — works as with PM2. `metrics` shows a refreshing `systemctl status` because there is no `pm2 monit`.

`shipnode restart` drops in-flight requests on a watt app. For a zero-drop roll, run `shipnode deploy` (blue-green).

## Switching an existing app

Add `.runtime('watt', { main })` and deploy. After the new release passes its health check and Caddy flips, the old PM2 process is removed. To go back, remove the `.runtime(...)` line and deploy again.

## Trade-offs

- **Weaker isolation.** Threads share a process, so a native crash or out-of-memory error takes down every web worker. `maxMemory` is passed to wattpm as its per-worker heap health threshold (`health.maxHeapUsed`).
- **Uneven spread is possible.** The kernel hashes each connection to a worker. Clients that share few source ports, such as a local proxy over loopback, can land unevenly. Validate with a real traffic split before rolling out widely.
- **Linux only** for more than one thread.

See the [design notes](https://github.com/devalade/shipnode/blob/main/docs/adr/0009-watt-runtime.md) for the reasoning.

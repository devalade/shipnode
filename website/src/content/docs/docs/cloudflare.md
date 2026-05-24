---
title: Cloudflare Tunnel
description: Expose your app through Cloudflare without opening ports.
---

ShipNode can run your VPS behind a Cloudflare Tunnel — no inbound 80/443 required, DDoS protection at the edge, optional Cloudflare Access in front of the app.

## Configure

```ts
export default shipnode
  .backend()
  .ssh({ host: '203.0.113.10', user: 'deploy' })
  .deployTo('/var/www/api')
  .pm2('api')
  .port(3000)
  .domain('api.example.com')
  .cloudflare({
    accountId: process.env.CF_ACCOUNT_ID!,
    apiToken: process.env.CF_API_TOKEN!,
    zone: 'example.com',
    access: { emails: ['ops@example.com'] }, // optional
  })
  .build();
```

## Provision

```bash
npx shipnode cloudflare init
```

This will:

1. Install `cloudflared` on the server
2. Create (or adopt) a named tunnel
3. Add the `CNAME` for `api.example.com` pointing at the tunnel
4. Configure Cloudflare Access if `access` is set
5. Enable the `cloudflared` systemd service

## Verify

```bash
npx shipnode cloudflare audit
npx shipnode cloudflare status
```

`audit` compares DNS + tunnel routes against your config. `status` shows the live service.

## Firewall

After the tunnel is healthy you can tighten UFW with `npx shipnode harden` — only port 22 needs to stay open.

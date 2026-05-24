---
title: Recipes
description: Copy-paste hook patterns for the things teams actually do during a deploy.
---

A growing set of [`preDeploy` / `postDeploy`](/docs/configuration/#hooks) snippets. Drop them straight into `shipnode.config.ts`.

All recipes assume:

```ts
import { shipnode } from '@devalade/shipnode';

export default shipnode
  .backend()
  .ssh({ host: '203.0.113.10', user: 'root' })
  .deployTo('/var/www/api')
  .pm2('api')
  .port(3000)
  // ...recipe goes here
  .build();
```

## Run database migrations

The single most common hook. Migrations run **before** the health check so a bad migration aborts the release.

### Prisma

```ts
.preDeploy(async (ctx) => {
  await ctx.exec('pnpm prisma migrate deploy');
})
```

### Drizzle

```ts
.preDeploy(async (ctx) => {
  await ctx.exec('pnpm drizzle-kit migrate');
})
```

### Kysely / raw `node-pg-migrate`

```ts
.preDeploy(async (ctx) => {
  await ctx.exec('pnpm node-pg-migrate up');
})
```

## Back up the database before migrating

Belt-and-braces for risky migrations. Snapshot, then migrate, then deploy.

```ts
.preDeploy(async (ctx) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await ctx.exec(`pg_dump "$DATABASE_URL" | gzip > /var/backups/api-pre-${stamp}.sql.gz`);
  await ctx.exec('pnpm prisma migrate deploy');
})
```

## Seed reference data

Idempotent seeds are safe to run every deploy. Wrap them in your own idempotency check (e.g. `INSERT ... ON CONFLICT DO NOTHING`).

```ts
.preDeploy(async (ctx) => {
  await ctx.exec('pnpm tsx scripts/seed-reference-data.ts');
})
```

## Notify Slack on deploy

```ts
.postDeploy(async (ctx) => {
  const sha = process.env.GIT_SHA ?? 'unknown';
  const payload = JSON.stringify({
    text: `:rocket: api deployed — \`${sha.slice(0, 7)}\``,
  });
  await ctx.exec(
    `curl -fsS -X POST -H 'Content-Type: application/json' -d '${payload}' "$SLACK_WEBHOOK"`
  );
})
```

The `SLACK_WEBHOOK` value lives in your server's `shared/.env` (uploaded with `shipnode env`), so the hook reads it implicitly through the shell.

## Notify Discord on deploy

```ts
.postDeploy(async (ctx) => {
  await ctx.exec(
    `curl -fsS -X POST -H 'Content-Type: application/json' ` +
    `-d '{"content":"\`api\` deployed"}' "$DISCORD_WEBHOOK"`
  );
})
```

## Tag a Sentry release

```ts
.postDeploy(async (ctx) => {
  const sha = process.env.GIT_SHA ?? 'unknown';
  await ctx.exec(`pnpm sentry-cli releases new ${sha}`);
  await ctx.exec(`pnpm sentry-cli releases set-commits ${sha} --auto`);
  await ctx.exec(`pnpm sentry-cli releases deploys ${sha} new -e production`);
})
```

Pair this with the `ci github` workflow — `GIT_SHA` is exported there.

## Purge a CDN cache

### Cloudflare

```ts
.postDeploy(async (ctx) => {
  await ctx.exec(
    `curl -fsS -X POST ` +
    `-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" ` +
    `-H "Content-Type: application/json" ` +
    `--data '{"purge_everything":true}' ` +
    `"https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/purge_cache"`
  );
})
```

## Prime the cache after deploy

Hit a few warm endpoints right after the symlink flip so the first real user doesn't pay cold-start latency.

```ts
.postDeploy(async (ctx) => {
  const urls = [
    'https://api.example.com/',
    'https://api.example.com/health',
    'https://api.example.com/v1/featured',
  ];
  for (const url of urls) {
    await ctx.exec(`curl -fsS -o /dev/null "${url}"`);
  }
})
```

## Abort deploy on lint or type errors

If you don't run these in CI yet, you can use `preDeploy` as a safety net — the deploy fails before the health check is even attempted.

```ts
.preDeploy(async (ctx) => {
  await ctx.exec('pnpm lint');
  await ctx.exec('pnpm typecheck');
})
```

:::caution
Move these to CI as soon as you can. Failing in `preDeploy` still consumes the new release directory and roundtrips through SSH; CI is faster and gives reviewers a signal in the PR.
:::

## Write a release marker file

Useful when a sidecar process (log shipper, error reporter) needs to know the current SHA.

```ts
.postDeploy(async (ctx) => {
  const sha = process.env.GIT_SHA ?? 'unknown';
  await ctx.exec(`echo "${sha}" > /var/www/api/shared/RELEASE`);
})
```

## Restart a sidecar service

If you run a non-PM2 service (e.g. systemd-managed worker) alongside the app:

```ts
.postDeploy(async (ctx) => {
  await ctx.exec('sudo systemctl restart api-worker.service');
})
```

## Combine multiple steps

A hook is just a function — chain whatever you need:

```ts
.postDeploy(async (ctx) => {
  const sha = process.env.GIT_SHA ?? 'unknown';

  // 1. Tag Sentry release
  await ctx.exec(`pnpm sentry-cli releases new ${sha}`);

  // 2. Purge CDN
  await ctx.exec(`curl -fsS -X POST ... /purge_cache`);

  // 3. Prime cache
  await ctx.exec('curl -fsS -o /dev/null https://api.example.com/');

  // 4. Notify Slack
  await ctx.exec(`curl -fsS -X POST -d '{"text":"deployed ${sha.slice(0,7)}"}' "$SLACK_WEBHOOK"`);
})
```

If anything throws in `preDeploy` the release rolls back. In `postDeploy` failures are logged but the release stays — the app is already serving traffic.

## Helpful patterns

- **Read env from `shared/.env`** by referencing variables in the shell command (`"$SLACK_WEBHOOK"`). `ctx.exec` runs in the release directory with the env loaded.
- **Stay idempotent.** Hooks run on every deploy — design them so repeat runs are safe (`INSERT ... ON CONFLICT`, `mkdir -p`, etc.).
- **Keep them fast.** Slow `postDeploy` hooks delay the next deploy. Move heavy work to a separate worker if it grows.
- **Don't shell out to your CI runner.** Hooks run on the **server**, not on your laptop or CI box. They have your server's network, your server's secrets, your server's filesystem.

Got a pattern that should be here? Open a PR against [`website/src/content/docs/docs/recipes.md`](https://github.com/devalade/shipnode/blob/v2/website/src/content/docs/docs/recipes.md).

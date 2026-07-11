# Blue-green releases via a two-port colour swap behind Caddy

The default deploy strategy stops the whole PM2 process set and starts the new release on the same port (`pm2 delete … && pm2 start …`). Between the delete and the moment the new process is listening — install relink, framework boot, first health probe — the port is closed and inbound requests are refused. For a plain web app that is a multi-second window of dropped requests on every deploy.

`zeroDowntime` opts a backend web app into blue-green releases that close that window.

## Mechanism

Two ports, named **blue** and **green**. Blue is the web app's configured `port`; green is `altPort` (default `port + 1`). Exactly one colour is *active* at a time — Caddy's `reverse_proxy` upstream points at it. The active colour and the port pair are persisted on the host in `<appPath>/.shipnode/deploy-state.json`.

Each deploy:

1. Stages the release and switches the `current` symlink (as always). The previously-started colour keeps running the old code in memory — the symlink move doesn't touch a running process.
2. Boots the **idle** colour on its own port (`pm2 start ecosystem.web.cjs`), reaping any stale same-colour instance first. The active colour is never touched. Workers are **not** reloaded yet.
3. Health-checks the new colour on **its** port and colour-suffixed pm2 name (`api-green`).
4. Only on success: reloads the single worker set against the new release, then rewrites the Caddy site to the new colour's port and `systemctl reload caddy` — a graceful reload that drains in-flight requests, so the flip drops nothing. Then persists the new active colour.

A failed health check throws before step 4: Caddy is untouched, workers stay on the previous release, the old colour is still serving, `current` is reverted to the previous release when one exists, and the failed colour is reaped by the next deploy. Zero user impact on a bad release — the main prize.

## Why the web app is duplicated but workers are not

Blue-green needs two copies of the *web* app (old + new, different ports) resident at once. Workers have no port and aren't behind Caddy; running two copies would double-process their queues. So the ecosystem is split: `ecosystem.web.cjs` holds only the colour-suffixed web app; `ecosystem.workers.cjs` holds the workers as a single set, reloaded in place **after** health passes (a brief worker blip on a successful deploy is acceptable — they're not serving HTTP). Reloading before health would leave workers on a bad release while traffic stayed on the old colour.

## Rollback is a flip, not a restart

Because the previous colour is still running, rollback is an instant Caddy flip back to it plus a state swap — no process restart, nothing dropped. Only one step back is supported (older colours were reaped); deeper rollbacks redeploy the target release the normal way.

## Trade-offs

- **~2× memory for the web app** — both colours are resident between deploys. Documented; the price of instant rollback.
- **The port pair is fixed at the first deploy** and persisted. Later changes to the web port or `altPort` in config are ignored until the state file is cleared, so a running colour is never silently re-homed.
- **Migration costs one restart.** The first `zeroDowntime` deploy deletes the pre-existing uncoloured web process (which holds the blue == web port) by name so the target colour can bind. After that, every deploy is zero-drop.
- **Opt-in, default off.** The recreate path is byte-for-byte unchanged, so existing deployments are unaffected until they set `zeroDowntime`.

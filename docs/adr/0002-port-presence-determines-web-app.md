# Port presence determines the web app; no `type` discriminator on `Pm2App`

`pm2.apps` is a uniform list of processes — web servers and workers share the same shape. The web app is identified by carrying a `port`; workers omit it. There is deliberately no `type: 'web' | 'worker'` field.

The discriminator would be a second source of truth that can disagree with itself: it would still be the `port` that drives the health check and Caddy upstream, so a `type: 'web'` entry without a port (or a `type: 'worker'` entry with one) would have to be rejected anyway. Encoding the same fact twice invites bugs. `assembleConfig` enforces: at most one port-bearing entry; zero is legal (worker-only deployments); a `domain` requires a web entry.

The cost is that "which entry is the web app?" isn't visible from a glance at one entry — you have to look at the list. We accept that in exchange for not maintaining a tagged union whose tag is redundant with its data.

# Fleet replication: one app on N servers behind a load balancer you own

An app whose `on` target resolves to more than one server is a **fleet**. Deploys roll through its replicas a batch at a time, draining each out of rotation before touching it. Everything about a single-server deploy is unchanged; a fleet is a loop above it.

## Shipnode does not manage the load balancer

You provision it — Hetzner, DigitalOcean, an ALB, an nginx someone else runs. Shipnode owns exactly one thing: a readiness endpoint on each replica that answers `200` normally and `503` while that replica is being deployed. Every managed load balancer decides rotation from a health check, so flipping that endpoint is enough to pull a replica out and put it back.

This is the whole integration, and it is deliberately tiny. No provider APIs, no credentials, no load balancer for shipnode to keep alive, and nothing to reimplement per provider. It also keeps the premise intact: shipnode still needs nothing but SSH.

The cost is one number shipnode cannot infer.

## `drainWait` is the load-bearing parameter

Shipnode flips the sentinel and knows immediately. The **load balancer** finds out on its next health check, and marks the replica unhealthy only after its failure threshold. Shipnode cannot see either setting, so it cannot know when traffic has actually stopped.

So you declare it. `fleet.drainWait` (default 30s) is how long shipnode waits after draining before it touches the app. Set it below your load balancer's *interval × unhealthy-threshold* and the roll drops requests — the replica is still receiving traffic when PM2 restarts. Getting it right is the difference between a zero-downtime roll and a visible outage, which is why it is a required concept rather than a tuning knob.

Verify it once, live: `curl` the load balancer in a loop during a deploy and confirm zero non-200s.

## Draining is a sentinel file, not a config rewrite

Drain writes `<remotePath>/<app>/.shipnode/drain`; undrain removes it. Caddy serves the readiness endpoint through a `file` matcher against that path — `503` when present, `200` otherwise.

The alternative was rewriting the site config and reloading Caddy, which the blue-green flip already does. The sentinel wins on three counts: flipping state is one `touch` with no reload, it takes effect immediately, and it survives a Caddy restart or a host reboot. That last point matters most — a replica drained by a failed roll **stays** drained until something undrains it, rather than quietly rejoining the pool when the host comes back.

## Replicas never claim the domain

`generateBackendCaddyfile` emits `api.example.com { reverse_proxy localhost:3000 }`. Put that on five boxes and all five race Let's Encrypt for a certificate on the same name.

A fleet replica instead serves `http://<privateHost>:<fleet.port>` — plain HTTP on the private network, no ACME, no domain. **TLS terminates at your load balancer**, which is how a managed LB is normally run. Pass-through TLS, where each replica holds the certificate, is out of scope; the plan says so rather than half-supporting it.

This is why every server in a fleet must declare `privateHost`. The schema enforces it.

## Blue-green within a replica, rolling across replicas

`DeployOrchestrator` was already the right unit of work for one replica and needed no rewrite. Blue-green, health checks, release symlinks and locking all stay intra-replica; the colour flip now rewrites the fleet site's upstream port instead of the public domain's.

Deploying one replica is: drain → wait `drainWait` → blue-green deploy → health check → undrain. `rollFleet` is the loop that does that to each replica in turn, and it is the operation-agnostic part — `rollback` drives the same loop with a different callback, so it inherits identical batching, drain timing and partial-failure reporting rather than reimplementing them.

## A failed roll is a state, not an exception

`rollFleet` resolves rather than throws when a replica fails. A partly-rolled fleet is a real condition the caller has to report, not an error to unwind:

- Replicas already updated keep serving the new release.
- Replicas not yet reached keep serving the old one.
- Replicas drained alongside the failure but never touched are returned to rotation — they are still healthy on the old release.
- **The replica that failed stays drained.** It is out of rotation, receiving no traffic, and can be inspected exactly as it died.

The roll stops there. `shipnode status` compares replicas and reports the skew explicitly, because nothing about a single replica reveals it.

## One release id for the whole roll

`deployApp` used to mint its own timestamp, which would give every replica a different release directory name and make a converged fleet indistinguishable from a half-rolled one. A fleet deploy mints one id up front and hands it to every replica, so `status` can compare directory names and answer the question.

A rollback passes none: an instant blue-green rollback flips colours and has no new release to name, and inventing a timestamp would be a lie in the status output.

## Run-once work needs its own hooks

`preDeploy` runs once per replica. On a five-server fleet a migration in `preDeploy` is five concurrent `db:apply` runs.

`.beforeFleet()` and `.afterFleet()` run exactly once per roll — on the first replica and the last — at the same points in the lifecycle as `preDeploy`/`postDeploy`, so they inherit the staged release, the dotenv wrapper, the `appRoot` and the output prefixing. `beforeFleet` lands while the old code is still serving (the expand half of expand/contract); `afterFleet` lands once every replica is on the new release (the contract half). A roll that dies partway never reaches its last replica, so `afterFleet` correctly never fires.

`preDeploy` keeps its per-replica meaning, unchanged for every existing single-server config. Deploy and `--dry-run` both warn when a fleet app declares it, naming the replica count.

## `placement: 'primary'` is about the server, not the roll

A queue worker competing for jobs *should* run on every replica. A cron or scheduler should not — three replicas means every job fires three times. `placement: 'primary'` pins a pm2 process to the first server the app is declared on.

Primary is deliberately a property of the **server**, not of the current roll. `shipnode deploy --on web-b` narrows the roll to one replica, and if primary were "first replica of this roll" that would promote web-b and start a second scheduler beside web-a's still-running one. The schema also rejects `placement: 'primary'` on a pm2 app with a port: the load balancer would keep routing to replicas serving nothing.

## Cross-server addressing is declared, not discovered

Docker networks are host-local, so `--network shipnode-private` connects nothing across machines. On one box `localhost` happens to work and hides the problem; split the app and its database and every connection string silently points at the wrong machine.

Each app is handed `SHIPNODE_<ACCESSORY>_HOST` for each accessory it depends on — `127.0.0.1` when co-located, the host's `privateHost` when not. The variable exists either way, so moving an accessory to its own server is a config change and not a code change. Declared env wins, which is the escape hatch for a managed database shipnode cannot see.

Injection happens during config assembly, not at deploy time: scoping the config to one app or one server drops the servers the dependencies are on, and by then the address is unknowable.

Accessories stay single-node. Shipnode replicating Postgres is out of scope, and the schema says so rather than letting someone try.

## What is deliberately not here

- **A shipnode-managed load balancer** — a Cloudflare tunnel with N connectors, or an edge Caddy node. The drain contract is designed so either could be added later as an alternative drain implementation without disturbing the roller.
- **Pass-through TLS.** Replicas serve plain HTTP; the LB terminates.
- **Replicated accessories.** One Postgres, on one server.
- **Building once and shipping the artifact.** Each replica still builds. With a committed lockfile the builds are equivalent, so this is a time optimisation rather than a correctness gate, and the two ways to implement it — building locally, or copying between servers — each impose an infrastructure requirement that has not been chosen.

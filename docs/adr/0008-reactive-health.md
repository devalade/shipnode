# Reactive health: no drain sentinel, no privateHost, one servers object

Three reversals to [ADR-0007](0007-fleet-replication.md), all in the same direction: the beta configs taught us what nobody used, and the machinery that existed only to serve it went with it.

## 1. The readiness endpoint is gone — the LB polls the app's own health path

ADR-0007 gave each replica a readiness endpoint, `/_shipnode/ready`, which answered `200` normally and `503` while the drain sentinel existed. The load balancer pulled a replica on that signal before a deploy touched it, and `fleet.drainWait` existed because shipnode could not know how long the LB would take to notice.

The machinery had one job: cover the window where a replica restarts its app in place. But fleet backends do not restart in place — they are blue-green, and blue-green never has that window:

- The new colour boots on `altPort` while the old colour keeps serving.
- The health check gates the switch. A failed check throws before anything flips; the old colour serves on.
- The switch is a graceful `systemctl reload caddy`. Port 80 never closes, in-flight requests drain.

So across a whole roll, the load balancer's check of the app's **own** health path — through the replica's Caddy to the app — stays `200` from the first replica to the last, including a failed roll. Draining proactively was redundant; `drainWait`, the number users had to match to their LB's `interval × unhealthy-threshold` on pain of dropped requests, was redundant with it.

The endpoint was also strictly worse than what replaces it: it answered `200` from a sentinel file, so a load balancer pointed at it could not see a replica whose app had *crashed* at runtime. A check through to the app sees exactly that, and the LB's own threshold does the pulling — no shipnode-specific endpoint, no `drain`/`undrain` commands, and the LB's configuration contains nothing shipnode-specific at all.

**The price:** a recreate-mode deploy restarts the app in place and drops requests until the LB notices. That is why blue-green is not optional on a fleet — assembly enables it for every fleet backend with a web port. An explicit `.noZeroDowntime()` is honoured (it is your outage to have), and frontends are exempt: they serve static files and restart nothing.

A second price is state: a failed roll used to leave the failed replica *drained* — out of rotation, inspectable. Now a replica whose deploy failed stays on its old release, healthy and serving. `shipnode status` still names the skew.

## 2. `privateHost` is gone

Every server used to be able to declare a private-network address, and every fleet member was *required* to — the LB was assumed to dial replicas over the private network, and cross-server accessory traffic was assumed to ride it.

Neither assumption survived the beta config. The replicas' Caddy now answers on every interface (`http://:80`, plus the app's domain over plain HTTP), because a host-bound site does not match on a NAT'd cloud box — the public IP is not on the interface. The LB can dial the public host, and the health check sends whatever Host it dials; the hostless site matches it. And a fleet spread across regions has no private network to name — the requirement made those fleets unparseable.

Cross-server accessory traffic (`SHIPNODE_<ACCESSORY>_HOST`) now uses the accessory server's `host`. That may ride the public internet; the firewall (`harden`, with `DOCKER-USER` rules) still restricts the port to the consuming replicas, and the config preview names the injected address so it is a decision rather than a surprise.

The servers object is now one thing: `{ user, hosts }`. The host string is the server's identity everywhere — `on`, `--on`, accessory `on`, status output — and `hosts` order is the roll order. Groups were deleted with the names; an app names its hosts directly.

## What supersedes what

- ADR-0007's *readiness endpoint*, *draining is a sentinel file*, *`drainWait` is load-bearing*, and *replicas never claim the domain (two-address binding)* sections are superseded. Replicas still never claim the domain for **TLS** — they serve plain HTTP on every interface and list the domain as an additional plain-HTTP site address.
- *Blue-green within a replica, rolling across replicas*, *one release id for the whole roll*, *run-once hooks*, and *primary is a property of the server* are unchanged.
- *A failed roll is a state, not an exception* is unchanged in structure; "the failed replica stays drained" is replaced by "the failed replica stays on its old release, serving."
- *Cross-server addressing is declared, not discovered* is unchanged in intent; the declared address is now the server's `host`.

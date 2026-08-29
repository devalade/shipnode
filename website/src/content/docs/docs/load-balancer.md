---
title: Load balancer
description: Fleets sit behind a load balancer you provision. Shipnode's entire integration is your app's own health path.
---

When an app's `on` target names more than one host, it becomes a **fleet** — the same app on N servers, deployed by rolling through the replicas one at a time. The replicas sit behind a load balancer that you provision: Hetzner, DigitalOcean, an ALB, an nginx box someone else runs. Shipnode never talks to it — no provider APIs, no credentials, and no shipnode-specific settings to enter. SSH is still the only thing shipnode needs.

## The whole integration

There is exactly one contract between your load balancer and shipnode, and you configure both halves in ordinary places:

1. **LB targets:** each replica's host, on the fleet port (80).
2. **LB health check:** your app's **own** health path (e.g. `/health`), over HTTP.
3. **TLS:** terminates at the load balancer. Replicas serve plain HTTP and never request a certificate — five replicas asking for one name would race Let's Encrypt.

Point your fleet app's DNS at the load balancer and give the app a `.domain()` — your LB forwards the client's `Host` header, so each replica has to recognise it. Shipnode configures the replica to answer on every interface on port 80 (which is what the LB's health check dials) and on the domain (for forwarded traffic), over plain HTTP.

## Why there is nothing else to configure

Blue-green is enabled automatically for fleet backends: a replica boots the new release on its idle colour, health-checks it, and only then does Caddy's upstream flip. The flip is graceful — port 80 never closes, in-flight requests drain — and a failed health check leaves the old colour serving untouched.

That means the load balancer's health check of your app stays `200` for the entire roll, including a failed roll: the replica that failed keeps serving its previous release, healthy, while the roll stops and reports the skew. Nothing is ever restarted in place while it serves traffic, so there is no drain step, no readiness endpoint, and no timing number to match to your load balancer. ADR-0008 records why the old drain machinery went away.

## Verify it once

The one thing worth doing before your first production roll is confirming the LB actually routes the way you think. While a deploy runs, curl the domain in a loop and expect zero non-200s:

```bash
while true; do
  code=$(curl -s -o /dev/null -w '%{http_code}' https://api.example.com)
  [ "$code" != 200 ] && echo "$(date +%T) $code"
  sleep 0.2
done
```

- Non-200s during the roll mean the load balancer is sending traffic to a replica that cannot serve it — check that its health check dials port 80 on each replica's host and that the app's health path answers there.
- A replica never entering rotation means the LB is dialing an address or port the replica is not serving.

## When a roll fails

A roll that fails partway reports it: replicas already updated keep serving the new release, untouched ones keep serving the old, and the failed replica stays on its previous release — healthy, serving, and inspectable. `shipnode status` compares replicas and names exactly which host is on which release:

```bash
shipnode status
```

Redeploy to converge the fleet. See [ADR-0007](https://github.com/devalade/shipnode/blob/main/docs/adr/0007-fleet-replication.md) and [ADR-0008](https://github.com/devalade/shipnode/blob/main/docs/adr/0008-reactive-health.md) for the design and its limits.

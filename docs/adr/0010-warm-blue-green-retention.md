# Warm blue-green retention is the default

[ADR-0005](0005-blue-green-zero-downtime.md) kept the previous colour running after every flip so a rollback was an instant Caddy flip. The cost is a second copy of every web app in memory, permanently. On a shared server with no swap that is the difference between fitting and being killed: running 40 small apps this way held roughly 3–4 GB that did nothing until someone rolled back.

`blueGreenRetention: 'none'` removed the cost but also removed rollback — `shipnode rollback` refused, and the only way back was a full redeploy. Nothing sat between the two.

## Decision

`warm` is the default, modelled on how Kamal handles old containers: stop the old version after a short drain, keep it on disk, and start it again on rollback.

- **After the flip.** Caddy has stopped sending the old colour new requests. Shipnode waits `DRAIN_SECONDS` (10) so requests already in flight can finish, then stops it: a PM2 process is deleted by exact name, a watt unit is stopped **and disabled** so it does not return on a reboot and hold memory for nothing. Its release directory is untouched (`keepReleases` still applies).
- **Recording what ran.** `deploy-state.json` gains `blueRelease` / `greenRelease`, the release each colour was last booted from. State written before this change has neither field, and rollback says so instead of guessing.
- **Rollback.** If the previous colour is running (`rollback` retention) it is still an instant flip. Otherwise shipnode points `current` at that colour's release — its launcher files resolve through `current` (ADR-0001), so starting it from anywhere else would run the wrong code — starts it from that release's own ecosystem file or unit, waits for its health check, flips Caddy, and then stops the colour that was serving. If it cannot start, the half-started colour is removed and `current` is restored, so a failed rollback leaves the app as it was.

## Modes

| | After the flip | `shipnode rollback` | Memory |
|---|---|---|---|
| `warm` (default) | stopped after a drain | boots it again, seconds | 1× |
| `rollback` | left running | instant flip | 2× |
| `none` | stopped after a drain | refused; redeploy | 1× |

## Trade-offs

- **Rollback is no longer instant by default.** It takes the colour's boot time plus its health check. An app that needs the instant flip sets `'rollback'`.
- **Changing the default changes behaviour for existing configs** that never set the option: their previous colour is now stopped after a flip. That is the intent, but it is a behaviour change and is recorded in the changelog.
- **Workers are not rolled back.** There is a single worker set, restarted against the new release in `afterHealthy`; a rollback moves web traffic only, as the instant flip always did.
- **The drain is a fixed wait,** not a check that connections have closed. It covers quick requests; a long-lived connection (WebSocket, streaming) can still be cut when the old colour stops.

# Monitor redesign: a shared observation layer

## Problem

`shipnode monitor` is a single-server Ink TUI with its data layer welded to React.
Four things are wrong with it at once:

1. **Fleet-blind.** `resolveMonitorSession` narrows to one replica because "the
   monitor holds one live connection". The one failure mode v3 introduced — a
   partly-rolled fleet — is therefore invisible in the live view and visible only
   in `status`, a one-shot text command.
2. **Overlapping surfaces.** `monitor`, `status`, and `logs` each reach the server
   their own way, so the same facts are gathered by three code paths.
3. **No machine-readable output.** No `--once`, no `--json`. Nothing to pipe into
   a script, a CI gate, or an alert.
4. **Layout hand-tuned to a 24-row terminal.** `releaseBoxExtra = min(6, rows-30)`,
   a fixed 60/40 split, fixed panel heights, and a 389-line `App.tsx` that owns
   keybindings, overlay routing, action dispatch, and layout at once.

## Scope

In scope: a shared observation layer, fleet visibility, `--once`/`--json`, and
rebuilding `status` and `logs` on the shared layer (they may change shape).

Out of scope for this spec: the TUI layout, the two views, and the keymap. Those
are designed separately once the foundation lands.

`shipnode metrics` stays as it is. It hands the terminal to PM2's own `pm2 monit`
over `ssh -t`, which is a deliberate escape hatch to the unfiltered truth when
shipnode's view and reality disagree — `monitor` filters PM2 to the app's
namespace and structurally cannot show that. It gains `--on` (so a fleet app is
targeted deliberately rather than by whichever host `getServerTargetResult`
returns) and honest help text; nothing else.

## Decision: collection is server-shaped, presentation pivots to app-shaped

Three models were considered.

- **App-shaped** — the subject is one app across its replicas. Fits v3's model
  (`on`, roll, convergence are all app-scoped), but duplicates and mis-attributes
  host-level facts: a box hosting three apps reports its load three times.
- **Server-shaped** — the subject is one server, N apps. Closest to today, and
  system stats and accessories land naturally, but an app can only be compared
  across replicas by switching servers and remembering.
- **Two-level (chosen)** — collect server-shaped, pivot to app-shaped for
  presentation.

Collection stays server-shaped, so nothing is polled twice and host-level facts
have one home. The pivot is a pure function over snapshots — no I/O, trivially
testable — and it is what lets `status` be a renderer rather than a second data
path.

## Architecture

```
domain/observe/
  snapshot.ts      ServerSnapshot / AppSnapshot / FleetView types
  parse.ts         section parsers (moved from cli/monitor/state.ts)
  script.ts        buildObserveScript — composite shell, section-selectable
  collector.ts     MetricsCollector — one server, N apps -> ServerSnapshot
  pivot.ts         pivotByApp(ServerSnapshot[]) -> FleetView[]

services/observe/
  session.ts       ObserveSession — N collectors, scheduling, history, events
  history.ts       MetricsHistory

cli/monitor/       Ink TUI: subscribes to an ObserveSession
cli/commands/      status / logs / monitor — three presenters, one session
```

**Boundary:** nothing under `domain/observe/` or `services/observe/` imports
React, Ink, or chalk. Today `use-monitor-data.ts` mixes polling, alerting, and
`chalk.red(...)` event strings — presentation decisions baked into the data
layer. Events become typed values; colour is chosen at render.

This follows the existing `domain/deploy` + `services` split rather than
inventing a new shape.

## Types

Today's `MetricsSnapshot` conflates three scopes: host-level (`system`),
app-level (`processes`, `releases`, `health`, `caddy`), and server-level
(`accessories`, `deployLock`). The split follows those seams.

```ts
interface ServerSnapshot {
  server: string;              // the host string — identity everywhere, per ADR-0008
  timestamp: string;
  system: SystemInfo;          // collected once, not once per app
  accessories?: AccessoryInfo[];
  deployLock: DeployLockInfo | null;
  apps: AppSnapshot[];
  error?: string;              // whole-server failure: unreachable, timeout
}

interface AppSnapshot {
  app: string;
  appType: 'backend' | 'frontend';
  processes: ProcessInfo[];
  currentRelease: string | null;
  releases: ReleaseRecord[];
  health?: HealthInfo;
  caddy?: CaddyInfo;
  error?: string;              // per-app failure: PM2 down for this namespace
}

interface FleetView {
  app: string;
  appType: 'backend' | 'frontend';
  replicas: Array<{
    server: string;
    snapshot: AppSnapshot;
    system: SystemInfo;
    reachable: boolean;
  }>;
  convergence: FleetConvergence;
}

function pivotByApp(snapshots: ServerSnapshot[]): FleetView[];
```

`SystemInfo`, `ProcessInfo`, `HealthInfo`, `AccessoryInfo`, `CaddyInfo`, and
`ReleaseRecord` move over unchanged — they are already well-shaped.

`deployLock` sits on the server because that is where the lock lives
(`{remotePath}/.shipnode/deploy.lock`), which today's per-app snapshot quietly
misrepresents.

`assembleConvergence` is reused as-is: `assessConvergence` already takes
`ReplicaObservation[]` (`{ server, release }`), so the pivot feeds it directly.
No new convergence logic, and `status`'s fleet reporting keeps working through a
path now shared with the live view.

## Data flow

```
ObserveSession.tick()
  -> for each server, bounded-parallel:  MetricsCollector.collect({ apps, sections })
  -> ServerSnapshot[]        (partial: an unreachable server yields error, not a throw)
  -> history.push per (server, app)
  -> health streaks + typed events
  -> pivotByApp()            -> FleetView[]
  -> notify subscribers with { servers, fleets, events, lastUpdate }
```

Both shapes are published every tick. The TUI's fleet view reads `fleets`, its
server view reads `servers`, `--json` emits `servers` (the collected truth) with
`fleets` derivable, and `status` renders the pivot. No mode re-polls.

## Collection decisions

Carried forward from today's poller:

- One SSH round trip per server per poll. The composite shell script with
  `@@SHIPNODE:<name>@@` section markers is the good part of the existing poller
  and survives intact — it now emits N apps per script instead of one, since
  `getAppsForServer` already says what is on the box.
- Accessories stay sampled on a slower cadence (~10s) than the main poll, with
  the previous value carried forward. `docker inspect` is the expensive section.
- The health probe stays bounded by `--max-time` derived from the interval, so a
  hanging probe cannot stretch a tick.
- Each section carries its own fallback, so one failing probe cannot blank the
  rest of the snapshot.

New:

- Parallel collection across servers is bounded at 4 concurrent connections; the
  rest queue within the tick. A 12-host fleet must not open 12 SSH connections.
- A tick that cannot finish within the interval is skipped rather than
  overlapped — today's `inFlightRef` guard, generalised per server.

## Error handling

Per AGENTS.md, `better-result` with typed `TaggedError` classes for expected
domain failures; exceptions only for programmer defects and adapter-boundary
infrastructure failures.

Failure is per-scope and never aborts a tick:

- A server that is unreachable or times out yields a `ServerSnapshot` with
  `error` set and no app data. Other servers still report.
- An app whose PM2 section fails yields an `AppSnapshot` with `error` set. Other
  apps on the same server still report.
- `assessConvergence` over a fleet with an unreachable replica reports the skew
  it can see and names the replica it could not reach, rather than claiming
  convergence from a partial observation. This matches the existing rule in
  `reportFleetConvergence` that a narrowed run reports nothing rather than
  reporting "converged" from one observation.

## Testing

`FakeRemoteExecutor` (`tests/testing/fake-executor.ts`) already supports
predicate-matched canned responses and command-history assertions, which covers
the collector without a network.

- `parse.ts` — the existing parser tests in `tests/unit/monitor.test.ts` move
  across unchanged; they are good and already cover malformed input.
- `script.ts` — section selection: which sections appear for backend vs frontend,
  with and without health checks and accessories, and N apps in one script.
- `collector.ts` — a canned multi-section stdout parses into a `ServerSnapshot`;
  a failing section degrades that section only; a timeout yields a server-level
  error.
- `pivot.ts` — pure function, so table-driven: converged fleet, skewed fleet,
  unreachable replica, single-server app, app absent from one server.
- `session.ts` — with fake collectors and fake timers: concurrency cap honoured,
  overlapping ticks skipped, accessory cadence, health-streak transitions in both
  directions, subscriber notification.

## Migration

The existing `cli/monitor/` TUI keeps working throughout: `state.ts` and
`poller.ts` become thin re-exports over `domain/observe/` until the TUI is
rewritten in the follow-up spec. No user-visible change lands until the surfaces
are rebuilt.

---
title: shipnode monitor
description: Live terminal dashboard across every server, with filterable streaming logs.
---

```bash
npx shipnode monitor                 # the whole workspace
npx shipnode monitor --app api       # one app, on every server it runs on
npx shipnode monitor --on web-2      # one server
npx shipnode monitor --once          # one snapshot, then exit
npx shipnode monitor --json          # the same snapshot as JSON
```

The monitor holds one SSH connection per server and shows three views.

**Fleet overview** lists every app on every server it runs on: the release each
replica serves, whether processes are up, CPU and memory, the health check, and
one sentence per app saying whether the fleet agrees. A half-finished rolling
deploy shows as `split across 2 releases`, the replica that missed it is marked
`behind`, and an unreachable server keeps its row. Below it, each server's CPU,
memory and disk, and any deploy lock. `↑/↓` selects, `Enter` opens a replica.

**Replica detail** is the per-process view: PM2 or systemd processes, system
gauges, accessories and releases. `Enter` on a process restarts it. `Enter` on a
release rolls back, except for an app that runs on several servers: rolling back
one replica would split the fleet, so use `shipnode rollback` for those.

**Logs** (`f`) streams every server's logs live into one merged view. Opening it
from the overview scopes it to the selected app; from a replica, to that app on
that server. Filters apply to what is already in the buffer, so changing them
never reconnects and never loses a line that was only hidden.

| Key | Action |
|---|---|
| `s` / `S` | Filter by server (next / previous), cycling through *all* |
| `a` / `A` | Filter by app |
| `p` / `P` | Filter by process |
| `v` | Level: all → warn and above → error only |
| `/` | Search: plain text, `/regex/`, or `!text` to exclude |
| `m` | Search mode: hide non-matching lines, or keep them dimmed for context |
| `c` | Clear filters |
| `space` | Pause and resume |
| `↑/↓`, `PgUp/PgDn` | Scroll back (pauses); `G` returns to the newest line |
| `C` | Clear the buffer |
| `Esc` / `f` | Back |

The filter bar shows live `ERR` and `WARN` counts under the current server, app
and search filters, so you can see what a level filter would show before you
switch to it. A source that stops delivering is retried with backoff and flagged
in the view. `l` toggles a small log strip under the overview and detail views.

The buffer keeps the newest 2,000 lines across all servers. Lines are ordered
by when they arrived here, not by the servers' clocks, which are not trusted to
agree.

## Options

| Flag | Purpose |
|---|---|
| `--interval <seconds>` | Polling interval (default `2`). |
| `--app <name>` | Watch one app. |
| `--on <server>` | Watch one server instead of the whole fleet. |
| `--once` | Collect one snapshot and exit. |
| `--json` | Print one snapshot as JSON (implies `--once`). |
| `--config <path>` | Use a non-default config file. |

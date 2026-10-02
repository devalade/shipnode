---
title: shipnode logs
description: Show or stream application logs from every server, with filters.
---

```bash
npx shipnode logs                       # last 100 lines per app, per server
npx shipnode logs --lines 500
npx shipnode logs --process mailer --app api
npx shipnode logs --follow              # stream every server live, merged
npx shipnode logs -f --level error      # only errors, from the whole fleet
npx shipnode logs -f --grep '/timeout|ECONN/i' --app api --on web-2
```

Without `--follow` the command prints recent history and exits. With it, every
server's logs are streamed over the SSH connections shipnode already opens and
merged into one stream until you press Ctrl-C. Lines are prefixed with the
server and app they came from (only the parts that vary), so a fleet's output
stays attributable. Log lines go to stdout and status to stderr, so
`shipnode logs -f | grep …` stays clean.

A dropped connection is retried with backoff, and the history the server replays
on reconnect is not printed twice.

## Options

| Flag | Purpose |
|---|---|
| `--lines <n>` | Lines of history to fetch (default `100`). With `--follow`, the backlog shown on connect. |
| `-f, --follow` | Stream new lines from every server until Ctrl-C. |
| `--level <level>` | Only this level and above: `warn` or `error`. Levels are read from JSON logs (`level`, `severity`), `[ERROR]`-style tags and plain `ERROR`/`WARN` words. |
| `--grep <pattern>` | Only matching lines. Plain text is a case-insensitive substring; `/regex/` (optionally `/regex/i`) is a regular expression; a leading `!` excludes. |
| `--process <name>` | Restrict to a single worker (use the short name from your config). Needs `--app`. |
| `--app <name>` | Restrict to one app. |
| `--on <server>` | Restrict to one server. |
| `--config <path>` | Use a non-default config file. |

Frontend apps stream the Caddy access log; an access-log line counts as `warn`
for a 4xx status and `error` for 5xx.

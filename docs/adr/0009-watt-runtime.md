# Opt-in `watt` runtime (wattpm) alongside PM2

PM2 stays the default. `runtime: 'watt'` (builder: `.runtime('watt', { main })`) runs the web app under wattpm instead: N worker threads in one process, each accepting straight from the kernel via `SO_REUSEPORT`, so no supervisor process sits in the request path and V8's startup state is not duplicated per worker.

## Mechanism

- **Web app** → wattpm. `instances` becomes the worker-thread count. Shipnode renders two per-release files into the app root (ADR-0001): `shipnode.watt.json` (runtime config, `port: "{PORT}"`) and `shipnode.platformatic.json` (tells `@platformatic/node` which file to load — `watt.main`). The runtime file has its own name and is passed with `wattpm start -c`: an app at path `.` would otherwise pick up a same-directory `watt.json` as *its own* config and fail to start.
- **Workers** (declared processes without a port) → one plain systemd unit each. wattpm supervises HTTP threads, not arbitrary commands, so workers keep an OS process and get systemd's restart/logging.
- **Supervision** → systemd units `shipnode-<namespace>[-<process>][-<colour>]`, each running a per-release launcher script (`shipnode-run-*.sh`). A script file sidesteps systemd's `%`/`$` expansion and keeps dotenv handling identical to PM2 (ADR-0003): the env file is parsed as data, never sourced.
- **Dependencies** → the app must list `wattpm` and `@platformatic/node` itself; deploy fails fast with the install command if they are missing. Shipnode does not install them globally, so the version the app was tested with is the version that runs.

## Zero-downtime

Blue-green (ADR-0005) works unchanged in shape: the idle colour is a separate unit (`shipnode-api-green`) on its own port, health-checked before Caddy flips. Workers are a single unit set restarted in `afterHealthy`. Rollback flips Caddy to the previous colour after checking its unit is `active`. Adopting watt on a host that ran PM2 retires the PM2 process after the first successful flip (`pm2 delete <namespace>`, a no-op when PM2 was never there).

## Trade-offs

- **`SO_REUSEPORT` is Linux-only.** On other OSes wattpm forces a single worker for the entrypoint (observed on macOS). Production VPSes are Linux; local runs are not representative of scaling.
- **Thread isolation is weaker than processes.** A native crash or OOM takes down every worker in the process; `health.maxHeapUsed` (from `maxMemory`) recycles a bloated worker before that.
- **`shipnode restart` is an in-place systemd restart**, not PM2's rolling `reload`. Use `deploy` (blue-green) for a zero-drop roll.
- **Load spread is kernel-hashed**, so clients that share few source ports (e.g. a local proxy over loopback) can land unevenly. Validate with a real traffic split before rolling out widely.
- **Not yet ported:** `status` and the monitor still read PM2 state; `harden`'s `pm2 save` step is skipped for watt apps because units are enabled at install time.

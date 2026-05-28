# Wrap PM2 scripts in `bash -c` that sources `.env`; don't use `env_file`

PM2 supports an `env_file` option that loads a dotenv file into the process environment. We relied on it through the 2.x line. In PM2 7.x deployments (confirmed against PM2 7.0.1) the option silently fails to inject variables — `pm2 env <id>` shows only the values written into the ecosystem's inline `env:` block, and the framework boot crashes with missing-env-var validation errors. The behaviour reproduces with both ecosystem-file starts and `--update-env` reloads.

We now drop `env_file` from the ecosystem and emit each app as a `bash` script whose args invoke the user's real command after sourcing the shared env file:

```js
{
  script: 'bash',
  args: ['-c', "set -a && . '/var/www/app/shared/.env.production' && set +a && exec node dist/server.js"],
  env: { NODE_ENV: 'production', PORT: 3000 }
}
```

`set -a` exports everything sourced. `exec` replaces the wrapper shell so PM2 supervises the real process directly — signals, reloads, and crash detection behave exactly as before. Per-app `env:` overrides (e.g. `WORKER_QUEUE`) still apply because PM2 layers them on top of the inherited env. Secrets stay in the chmod-600 `.env` file; they do **not** leak into the world-readable `ecosystem.config.cjs`.

`args` is emitted as an array because PM2 word-splits string args on whitespace, which would shred the inline shell snippet.

The alternative was to write a per-app wrapper script (`<release>/.shipnode/run-<name>.sh`) and point PM2's `script` at it. That works and reads slightly cleaner in `pm2 list` output, but it adds another file per app per release and another piece of state to keep consistent. The inline `bash -c` form ships zero new files and keeps everything visible by inspecting `ecosystem.config.cjs` — preferred until we have a second reason to introduce wrapper scripts.

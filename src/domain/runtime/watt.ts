import type { Pm2App, PkgManager, ShipnodeApp, WattConfig } from '../../shared/types.js';
import { getPm2Name } from '../pm2/apps.js';
import { runWithDotenv } from '../deploy/dotenv.js';
import { readDeployState, otherColor, type DeployColor } from '../deploy/blue-green.js';
import type { RemoteExecutor } from '../remote/executor.js';

/**
 * The opt-in `watt` runtime (wattpm).
 *
 * The web app runs under wattpm: N worker threads in one process, each
 * accepting straight from the kernel via SO_REUSEPORT — no supervisor in the
 * request path. Every other declared process (workers) keeps its own OS process
 * as a plain systemd unit, so it is supervised, restarted and logged the same
 * way. wattpm supplies the threading; systemd supplies the supervision that
 * PM2 would otherwise provide.
 *
 * Everything here is a pure renderer or command builder so it can be tested
 * without a host. See docs/adr/0009-watt-runtime.md.
 */

/** Per-release file names. They live next to the app so `current/` resolves them (ADR-0001). */
export const WATT_RUNTIME_FILE = 'shipnode.watt.json';
export const WATT_APP_FILE = 'shipnode.platformatic.json';

const DEFAULT_MODULE = '@platformatic/node';

/**
 * The wattpm version shipnode's rendered configs target. It is the schema
 * version below and the version installed when an app does not list wattpm
 * itself, so the two cannot drift apart.
 */
export const WATT_VERSION = '3.71.0';
const MISE_PATH = 'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"';

export function isWatt(app: Pick<ShipnodeApp, 'runtime'>): boolean {
  return app.runtime === 'watt';
}

/** systemd unit name for a declared process, optionally suffixed with a blue-green colour. */
export function wattUnitName(namespace: string, appName: string, color?: DeployColor): string {
  return `shipnode-${getPm2Name(namespace, appName)}${color ? `-${color}` : ''}`;
}

/** File name of the per-release launcher for a process, per colour when blue-green. */
export function runScriptName(appName: string, color?: DeployColor): string {
  return `shipnode-run-${appName}${color ? `-${color}` : ''}.sh`;
}

/** `512M` / `1G` / `2048K` / `1048576` → bytes. Returns undefined for anything else. */
export function parseSize(size: string | undefined): number | undefined {
  if (!size) return undefined;
  const match = /^(\d+)([KMG]?)$/i.exec(size.trim());
  if (!match) return undefined;
  const unit = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[2].toUpperCase() as '' | 'K' | 'M' | 'G'];
  return Number(match[1]) * unit;
}

/**
 * The wattpm runtime config for the web app. The port is `{PORT}` so one file
 * serves both blue-green colours; each colour's launcher sets PORT.
 */
export function renderRuntimeConfig(web: Pm2App, watt: WattConfig): string {
  const heap = parseSize(watt.maxHeapUsed ?? web.maxMemory);
  const config = {
    $schema: `https://schemas.platformatic.dev/wattpm/${WATT_VERSION}.json`,
    entrypoint: 'web',
    workers: { static: web.instances ?? 1 },
    server: { hostname: '0.0.0.0', port: '{PORT}' },
    applications: [{ id: 'web', path: '.', config: WATT_APP_FILE }],
    restartOnError: true,
    health: { enabled: true, ...(heap !== undefined ? { maxHeapUsed: heap } : {}) },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** The capability config that tells wattpm how to load the app inside each worker thread. */
export function renderAppConfig(watt: WattConfig): string {
  const config = {
    $schema: `https://schemas.platformatic.dev/@platformatic/node/${WATT_VERSION}.json`,
    module: watt.module ?? DEFAULT_MODULE,
    node: { main: watt.main },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

export interface RunScriptInput {
  /** Absolute directory the process starts from (the release's app root via `current`). */
  cwd: string;
  /** Command line to exec, e.g. `./node_modules/.bin/wattpm start -c shipnode.watt.json`. */
  command: string;
  envFile?: string;
  env: Record<string, string | number>;
}

/** Quote one ExecStart argument: spaces stay in one word, and `\`, `"` and `%` are not interpreted by systemd. */
function systemdQuote(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%')}"`;
}

/** systemd reads a unit line by line: a CR/LF/NUL in a value would add directives or corrupt the unit. */
function assertUnitSafe(label: string, value: string): void {
  if (/[\r\n\0]/.test(value)) throw new Error(`Cannot render systemd unit: ${label} contains a control character`);
}

/**
 * Launcher script the systemd unit executes. A script file (rather than an
 * inline ExecStart) sidesteps systemd's own quoting and `%`/`$` expansion, and
 * keeps the dotenv handling identical to the PM2 path (ADR-0003): the env file
 * is parsed as data, never sourced.
 */
export function renderRunScript(input: RunScriptInput): string {
  const exec = `exec mise exec -- ${input.command}`;
  const body = runWithDotenv(input.envFile, exec, input.env);
  const exports = input.envFile
    ? ''
    : Object.entries(input.env).map(([k, v]) => `export ${k}='${String(v).replace(/'/g, `'"'"'`)}'\n`).join('');
  return `#!/usr/bin/env bash\nset -e\n${MISE_PATH}\ncd "${input.cwd}"\n${exports}${body}\n`;
}

export interface UnitInput {
  description: string;
  user: string;
  workingDirectory: string;
  script: string;
}

export function renderUnit(input: UnitInput): string {
  assertUnitSafe('description', input.description);
  assertUnitSafe('user', input.user);
  assertUnitSafe('working directory', input.workingDirectory);
  assertUnitSafe('script path', input.script);
  return `[Unit]
Description=${input.description}
After=network.target

[Service]
Type=simple
User=${input.user}
WorkingDirectory=${input.workingDirectory}
ExecStart=/usr/bin/env bash ${systemdQuote(input.script)}
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=30
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
`;
}

// ---------------------------------------------------------------------------
// Remote command builders. Each is a self-contained shell snippet: it elevates
// only when not already root, so it works for both `root` and a NOPASSWD deploy
// user (the identity `shipnode setup` provisions).
// ---------------------------------------------------------------------------

const SUDO = 'S=$([ "$(id -u)" = 0 ] || echo sudo)';

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function unitPath(unit: string): string {
  return `/etc/systemd/system/${unit}.service`;
}

/** Write the unit file, reload systemd and enable it at boot. Does not start it. */
export function installUnitCommand(unit: string, content: string): string {
  return `${SUDO}; printf '%s' ${quote(content)} | $S tee ${unitPath(unit)} >/dev/null && ` +
    `$S systemctl daemon-reload && $S systemctl enable ${unit}`;
}

/** Start the unit, or restart it onto the newly linked release. */
export function restartUnitCommand(unit: string): string {
  return `${SUDO}; $S systemctl restart ${unit}`;
}

export function stopUnitCommand(unit: string): string {
  return `${SUDO}; $S systemctl stop ${unit} 2>/dev/null || true`;
}

/** Stop, disable and delete a unit; a missing unit is not an error. */
export function removeUnitCommand(unit: string): string {
  return `${SUDO}; $S systemctl disable --now ${unit} 2>/dev/null || true; ` +
    `$S rm -f ${unitPath(unit)}; $S systemctl daemon-reload`;
}

export function logsCommand(unit: string, opts: { follow?: boolean; lines?: number } = {}): string {
  return `${SUDO}; $S journalctl -u ${unit} -n ${opts.lines ?? 100} --no-pager${opts.follow ? ' -f' : ''}`;
}

/** Fails (non-zero) when a port is already bound by something else. */
export function portFreeGuard(port: number): string {
  return `{ if ss -tlnp | grep -q ":${port} "; then echo "Port ${port} is already in use by another process" >&2; false; else true; fi; }`;
}

/**
 * Best-effort removal of a PM2 process by exact name. Adopting watt on a host
 * whose app ran blue-green under PM2 leaves the idle colour's PM2 process
 * resident on the port the watt unit is about to bind.
 */
export function pm2DeleteCommand(name: string): string {
  return `{ mise exec -- pm2 delete "${name}" 2>/dev/null || true; }`;
}

/** `add` command per package manager, run in the app root of the release. */
const ADD_COMMANDS: Record<PkgManager, string> = {
  npm: 'npm install --no-audit --no-fund',
  pnpm: 'pnpm add',
  yarn: 'yarn add',
  bun: 'bun add',
};

/**
 * Installs wattpm (and the default capability module) at the version shipnode
 * targets when the release does not already have them. Packages the app lists
 * itself are left alone, so an app that pins its own versions keeps them. Runs
 * after the release's normal install and relink, so nothing prunes the result.
 * A custom `module` is never auto-installed; the guard below reports it.
 */
export function wattEnsureInstalledCommand(cwd: string, watt: WattConfig, pkgManager: PkgManager): string {
  const missing = [
    `[ -x "${cwd}/node_modules/.bin/wattpm" ] || pkgs="$pkgs wattpm@${WATT_VERSION}"`,
    ...(watt.module === undefined
      ? [`[ -d "${cwd}/node_modules/${DEFAULT_MODULE}" ] || pkgs="$pkgs ${DEFAULT_MODULE}@${WATT_VERSION}"`]
      : []),
  ];
  return `{ pkgs=""; ${missing.join('; ')}; ` +
    `if [ -n "$pkgs" ]; then echo "wattpm not in dependencies, installing:$pkgs"; cd "${cwd}" && ${ADD_COMMANDS[pkgManager]} $pkgs; fi; }`;
}

/** Fails with an actionable message when wattpm is still not installed in the release. */
export function wattInstalledGuard(cwd: string, watt: WattConfig): string {
  const module = watt.module ?? DEFAULT_MODULE;
  return `{ [ -x "${cwd}/node_modules/.bin/wattpm" ] && [ -d "${cwd}/node_modules/${module}" ] || ` +
    `{ echo "runtime 'watt' needs wattpm and ${module} in your dependencies: npm i wattpm ${module}" >&2; false; }; }`;
}

/** The command line the web launcher execs. */
export const WATT_START_COMMAND = `./node_modules/.bin/wattpm start -c ${WATT_RUNTIME_FILE}`;

/**
 * The systemd units a CLI verb should act on.
 *
 * Under blue-green the web unit carries a colour that only the host knows (it
 * is persisted in deploy-state.json), so it is resolved by asking the host.
 * `restart`/`logs` want the serving colour; `stop` wants every colour that may
 * still be resident so nothing keeps holding the port.
 */
export async function resolveWattUnits(
  executor: RemoteExecutor,
  appPath: string,
  app: ShipnodeApp,
  opts: { process?: string; colors: 'active' | 'all' },
): Promise<string[]> {
  const procs = app.pm2?.apps ?? [];
  if (procs.length === 0) return [];
  const namespace = procs[0].name;
  const selected = opts.process ? procs.filter((p) => p.name === opts.process) : procs;
  if (opts.process && selected.length === 0) {
    throw new Error(`No process named '${opts.process}' in this deployment. Known: ${procs.map((p) => p.name).join(', ')}`);
  }

  const state = app.zeroDowntime ? await readDeployState(executor, appPath) : null;
  const units: string[] = [];
  for (const proc of selected) {
    if (proc.port === undefined || !state) {
      units.push(wattUnitName(namespace, proc.name));
    } else if (opts.colors === 'active') {
      units.push(wattUnitName(namespace, proc.name, state.activeColor));
    } else {
      units.push(wattUnitName(namespace, proc.name, state.activeColor), wattUnitName(namespace, proc.name, otherColor(state.activeColor)));
    }
  }
  return units;
}

/** Exit 0 when the unit is active. */
export function isActiveCommand(unit: string): string {
  return `systemctl is-active --quiet ${unit}`;
}

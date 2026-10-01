import type { ShipnodeApp, ShipnodeConfig } from '../../shared/types.js';
import { isWatt, wattUnitName } from '../runtime/watt.js';

export const MISE = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
export const PM2_FAILED = '##SHIPNODE_PM2_FAILED##';

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

/**
 * Sections are addressed by the app's *index* in the request, not its name.
 * App names are user-supplied and would have to be escaped into the marker
 * grammar; an index needs no escaping and the caller already holds the array
 * that resolves it.
 */
export function appSectionName(index: number, section: string): string {
  return `a${index}-${section}`;
}

function sectionMarker(name: string): string {
  return `echo "@@SHIPNODE:${name}@@"`;
}

function buildSystemSection(): string {
  return [
    `echo "mem:$(free -m | awk '/^Mem:/{print $2, $3}')"`,
    `echo "load:$(awk '{print $1, $2, $3}' /proc/loadavg)"`,
    `echo "cores:$(nproc 2>/dev/null || echo 1)"`,
    `echo "uptime:$(cat /proc/uptime | awk '{print $1}')"`,
    `echo "disk:$(df -BG --output=size,used / 2>/dev/null | tail -1 | awk '{print $1+0, $2+0}')"`,
  ].join('; ');
}

function buildLockSection(lockPath: string): string {
  // Directory lock (atomic mkdir) stores the timestamp in acquired;
  // legacy file locks store it as the file contents.
  return (
    `if [ -d "${lockPath}" ]; then ` +
    `echo "$(cat "${lockPath}/acquired" 2>/dev/null) $(( $(date +%s) - $(stat -c %Y "${lockPath}" 2>/dev/null || date +%s) ))"; ` +
    `elif [ -f "${lockPath}" ]; then ` +
    `echo "$(cat "${lockPath}" 2>/dev/null) $(( $(date +%s) - $(stat -c %Y "${lockPath}" 2>/dev/null || date +%s) ))"; ` +
    `else echo "none"; fi`
  );
}

function buildHealthSection(port: number, path: string, maxTimeSeconds: number): string {
  const url = `http://localhost:${port}${path}`;
  return (
    `start=$(date +%s%N); ` +
    `code=$(curl -s -o /dev/null -w "%{http_code}" --max-time ${maxTimeSeconds} "${url}" 2>/dev/null); ` +
    `end=$(date +%s%N); ` +
    `echo "$code $(( (end - start) / 1000000 ))"`
  );
}

/**
 * Every unit that could exist for a watt app: the web app in each colour plus
 * the uncoloured form (recreate mode, or pre-blue-green), and each worker.
 * Units that do not exist report `LoadState=not-found` and are dropped by the
 * parser, so the script needs no state file lookup.
 */
export function wattCandidateUnits(app: ShipnodeApp): string[] {
  const procs = app.pm2?.apps ?? [];
  const namespace = procs[0]?.name ?? '';
  return procs.flatMap((proc) =>
    proc.port === undefined
      ? [wattUnitName(namespace, proc.name)]
      : [
          wattUnitName(namespace, proc.name),
          wattUnitName(namespace, proc.name, 'blue'),
          wattUnitName(namespace, proc.name, 'green'),
        ],
  );
}

/**
 * systemd's answer to `pm2 jlist`. CPU is a rate, and systemd only exposes a
 * cumulative counter, so the section samples it twice ~200ms apart within the
 * one script — a stateless collector cannot diff against a previous tick.
 */
function buildUnitsSection(units: string[]): string {
  const list = units.map(shellQuote).join(' ');
  const props = '-p LoadState -p ActiveState -p SubState -p MainPID -p MemoryCurrent -p NRestarts -p ExecMainStatus -p CPUUsageNSec';
  return (
    `t0=$(date +%s%N); ` +
    `for u in ${list}; do echo "@unit $u"; systemctl show "$u" ${props} 2>/dev/null; ` +
    `s=$(systemctl show "$u" -p ActiveEnterTimestamp --value 2>/dev/null); echo "started=$(date -d "$s" +%s 2>/dev/null)"; done; ` +
    `sleep 0.2; t1=$(date +%s%N); echo "@wall $((t1-t0))"; ` +
    `for u in ${list}; do echo "@cpu $u $(systemctl show "$u" -p CPUUsageNSec --value 2>/dev/null)"; done`
  );
}

function buildAccessoriesSection(names: string[]): string {
  const containers = names.map((name) => shellQuote(`shipnode-${name}`)).join(' ');
  // `sudo -n` fails instantly without a NOPASSWD rule instead of hanging the poll.
  return (
    `sudo -n docker inspect ` +
    `--format '{{.Name}}|{{.State.Status}}|{{.State.Health.Status}}|{{.Config.Image}}' ` +
    `${containers} 2>/dev/null || true`
  );
}

export interface ObserveRequest {
  /** Apps to sample on this server, in the order their sections are addressed. */
  apps: ShipnodeApp[];
  /** Upper bound in seconds for each HTTP health probe, so it never stretches a poll. */
  healthMaxTimeSeconds?: number;
  /** Accessory names (without the `shipnode-` prefix) to sample docker state for; omit to skip. */
  accessoryNames?: string[];
}

/**
 * One shell script covering every metric a poll needs from one server, so a
 * tick costs a single SSH round trip per host regardless of how many apps live
 * there. Sections are delimited by `@@SHIPNODE:<name>@@` marker lines and
 * joined with `;` — each section carries its own fallback so one failing probe
 * cannot blank out the rest of the snapshot.
 *
 * Host-level sections (system, deploy lock, accessories) are emitted once, not
 * once per app: they describe the box, and repeating them per app would both
 * waste the round trip and invite three different answers to the same question.
 */
export function buildObserveScript(config: ShipnodeConfig, request: ObserveRequest): string {
  const lockFile = `${config.remotePath}/.shipnode/deploy.lock`;
  const sections: Array<[string, string]> = [
    ['sys', buildSystemSection()],
    ['lock', buildLockSection(lockFile)],
  ];

  if (request.accessoryNames !== undefined && request.accessoryNames.length > 0) {
    sections.push(['accessories', buildAccessoriesSection(request.accessoryNames)]);
  }

  request.apps.forEach((app, index) => {
    const appPath = `${config.remotePath}/${app.name}`;
    const named = (section: string): string => appSectionName(index, section);

    if (app.appType === 'backend' && app.pm2 && isWatt(app)) {
      sections.push([named('units'), buildUnitsSection(wattCandidateUnits(app))]);
    } else {
      sections.push([
        named('pm2'),
        app.appType === 'backend' && app.pm2 ? `pm2 jlist 2>/dev/null || echo "${PM2_FAILED}"` : `echo "[]"`,
      ]);
    }
    sections.push([named('current'), `readlink "${appPath}/current" 2>/dev/null || echo "none"`]);
    sections.push([named('releases'), `cat "${appPath}/.shipnode/releases.json" 2>/dev/null || echo "[]"`]);

    const webPort = app.pm2?.apps.find((pm2App) => pm2App.port !== undefined)?.port;
    if (app.healthCheck.enabled && webPort !== undefined) {
      const maxTime = Math.max(
        1,
        Math.min(app.healthCheck.timeout, request.healthMaxTimeSeconds ?? app.healthCheck.timeout),
      );
      sections.push([named('health'), buildHealthSection(webPort, app.healthCheck.path, maxTime)]);
    }

    if (app.appType === 'frontend') {
      const logFile = `/var/log/caddy/${app.name}.log`;
      sections.push([named('caddy-status'), `systemctl is-active caddy 2>/dev/null || echo "unknown"`]);
      sections.push([
        named('caddy-log'),
        `sudo -n tail -n 50 "${logFile}" 2>/dev/null || tail -n 50 "${logFile}" 2>/dev/null || true`,
      ]);
    }
  });

  const script = sections.map(([name, command]) => `${sectionMarker(name)}; ${command}`);
  return [MISE, ...script].join('; ');
}

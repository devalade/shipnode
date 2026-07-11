import type { RemoteExecutor } from '../../domain/remote/executor.js';
import type { ShipnodeConfig, ShipnodeApp } from '../../shared/types.js';
import type { MetricsSnapshot } from './state.js';
import {
  parsePm2Jlist,
  parseSystemStats,
  parseReleaseRecords,
  parseDeployLock,
  parseHealthProbe,
  parseAccessoryStatus,
  parseCaddyInfo,
  splitSections,
} from './state.js';

export const MISE = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
const PM2_FAILED = '##SHIPNODE_PM2_FAILED##';

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function sectionMarker(name: string): string {
  return `echo "@@SHIPNODE:${name}@@"`;
}

function buildSystemSection(): string {
  return [
    `echo "mem:$(free -mb | awk '/^Mem:/{print $2, $3}')"`,
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

function buildAccessoriesSection(names: string[]): string {
  const containers = names.map((name) => shellQuote(`shipnode-${name}`)).join(' ');
  // `sudo -n` fails instantly without a NOPASSWD rule instead of hanging the poll.
  return (
    `sudo -n docker inspect ` +
    `--format '{{.Name}}|{{.State.Status}}|{{.State.Health.Status}}|{{.Config.Image}}' ` +
    `${containers} 2>/dev/null || true`
  );
}

export interface MonitorCommandOptions {
  /** Upper bound in seconds for the HTTP health probe, so it never stretches a poll. */
  healthMaxTimeSeconds?: number;
  /** Accessory names (without the shipnode- prefix) to sample docker state for on this poll. */
  accessoryNames?: string[];
}

/**
 * One shell script covering every metric the monitor needs, so a poll costs a
 * single SSH round trip. Sections are delimited by `@@SHIPNODE:<name>@@`
 * marker lines and joined with `;` — each section carries its own fallback so
 * one failing probe cannot blank out the rest of the snapshot.
 */
export function buildMonitorCommand(
  app: ShipnodeApp,
  config: ShipnodeConfig,
  options: MonitorCommandOptions = {},
): string {
  const appPath = `${config.remotePath}/${app.name}`;
  const lockFile = `${config.remotePath}/.shipnode/deploy.lock`;

  const pm2Command =
    app.appType === 'backend' && app.pm2
      ? `pm2 jlist 2>/dev/null || echo "${PM2_FAILED}"`
      : `echo "[]"`;

  const sections: Array<[string, string]> = [
    ['pm2', pm2Command],
    ['sys', buildSystemSection()],
    ['current', `readlink "${appPath}/current" 2>/dev/null || echo "none"`],
    ['releases', `cat "${appPath}/.shipnode/releases.json" 2>/dev/null || echo "[]"`],
    ['lock', buildLockSection(lockFile)],
  ];

  const webPort = app.pm2?.apps.find((pm2App) => pm2App.port !== undefined)?.port;
  if (app.healthCheck.enabled && webPort !== undefined) {
    const maxTime = Math.max(
      1,
      Math.min(app.healthCheck.timeout, options.healthMaxTimeSeconds ?? app.healthCheck.timeout),
    );
    sections.push(['health', buildHealthSection(webPort, app.healthCheck.path, maxTime)]);
  }

  if (options.accessoryNames !== undefined && options.accessoryNames.length > 0) {
    sections.push(['accessories', buildAccessoriesSection(options.accessoryNames)]);
  }

  if (app.appType === 'frontend') {
    const logFile = `/var/log/caddy/${app.name}.log`;
    sections.push(['caddy-status', `systemctl is-active caddy 2>/dev/null || echo "unknown"`]);
    sections.push([
      'caddy-log',
      `sudo -n tail -n 50 "${logFile}" 2>/dev/null || tail -n 50 "${logFile}" 2>/dev/null || true`,
    ]);
  }

  const script = sections.map(([name, command]) => `${sectionMarker(name)}; ${command}`);
  return [MISE, ...script].join('; ');
}

export interface CollectMetricsOptions {
  /** Poll interval in seconds; bounds both the SSH timeout and the health probe. */
  intervalSeconds?: number;
  /** Accessory names to sample this poll; omit to skip the accessories section. */
  accessoryNames?: string[];
}

export async function collectMetrics(
  executor: RemoteExecutor,
  app: ShipnodeApp,
  config: ShipnodeConfig,
  options: CollectMetricsOptions = {},
): Promise<MetricsSnapshot> {
  const timestamp = new Date().toISOString();
  const namespace = app.pm2?.apps[0]?.name ?? '';
  const intervalSeconds = options.intervalSeconds ?? 2;

  const command = buildMonitorCommand(app, config, {
    healthMaxTimeSeconds: intervalSeconds,
    accessoryNames: options.accessoryNames,
  });
  const result = await executor.exec(command, { timeout: intervalSeconds * 3000 });
  const sections = splitSections(result.stdout);

  const pm2Section = sections.get('pm2') ?? '';
  const currentRaw = (sections.get('current') ?? 'none').trim();
  const healthSection = sections.get('health');
  const accessoriesSection = sections.get('accessories');

  return {
    timestamp,
    processes: parsePm2Jlist(pm2Section, namespace),
    system: parseSystemStats(sections.get('sys') ?? ''),
    currentRelease: currentRaw === 'none' || currentRaw === '' ? null : currentRaw,
    releases: parseReleaseRecords(sections.get('releases') ?? ''),
    deployLock: parseDeployLock(sections.get('lock') ?? ''),
    health: healthSection === undefined ? undefined : parseHealthProbe(healthSection) ?? undefined,
    accessories: accessoriesSection === undefined ? undefined : parseAccessoryStatus(accessoriesSection),
    caddy:
      app.appType === 'frontend'
        ? parseCaddyInfo(sections.get('caddy-status') ?? '', sections.get('caddy-log') ?? '')
        : undefined,
    error: resolveSnapshotError(app, pm2Section, sections.size),
  };
}

function resolveSnapshotError(
  app: ShipnodeApp,
  pm2Section: string,
  sectionCount: number,
): string | undefined {
  if (sectionCount === 0) return 'Monitor poll returned no data';
  if (app.appType === 'backend' && app.pm2 && pm2Section.includes(PM2_FAILED)) {
    return 'PM2 command failed';
  }
  return undefined;
}

export async function collectLogs(
  executor: RemoteExecutor,
  namespace: string,
  lines: number = 20,
): Promise<string> {
  const result = await executor.exec(
    `${MISE} && pm2 logs ${shellQuote(namespace)} --lines ${lines} --nostream 2>&1 || echo "(no logs)"`,
  );
  return result.stdout;
}

export async function collectCaddyLogs(
  executor: RemoteExecutor,
  appName: string,
  lines: number = 50,
): Promise<string> {
  const logFile = `/var/log/caddy/${appName}.log`;
  const result = await executor.exec(
    `sudo -n tail -n ${lines} "${logFile}" 2>/dev/null || tail -n ${lines} "${logFile}" 2>/dev/null || echo "(no logs)"`,
  );
  return result.stdout;
}

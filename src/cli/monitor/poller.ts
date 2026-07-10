import type { RemoteExecutor } from '../../domain/remote/executor.js';
import type { ShipnodeConfig, ShipnodeApp } from '../../shared/types.js';
import { getDeploymentName } from '../../domain/pm2/apps.js';
import type { MetricsSnapshot } from './state.js';
import { parsePm2Jlist, parseSystemStats, parseReleaseRecords } from './state.js';

const MISE = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;

function buildSystemInfoCommand(): string {
  return [
    `echo "mem:$(free -mb | awk '/^Mem:/{print $2, $3}')"`,
    `echo "load:$(awk '{print $1}' /proc/loadavg)"`,
    `echo "uptime:$(cat /proc/uptime | awk '{print $1}')"`,
    `echo "disk:$(df -BG --output=size,used / | tail -1 | awk '{print $1+0, $2+0}')"`,
  ].join(' && ');
}

export async function collectMetrics(
  executor: RemoteExecutor,
  app: ShipnodeApp,
  config: ShipnodeConfig,
): Promise<MetricsSnapshot> {
  const timestamp = new Date().toISOString();
  const appPath = `${config.remotePath}/${app.name}`;

  const mise = app.appType === 'backend' ? MISE : '';
  const namespace = app.pm2?.apps[0]?.name ?? '';
  const deployName = getDeploymentName({ ...config, apps: [app] } as ShipnodeConfig) ?? namespace;

  const pm2Result = await executor.exec(
    app.appType === 'backend' && app.pm2 ? `${mise} && pm2 jlist` : 'echo "[]"',
  );

  const sysResult = await executor.exec(buildSystemInfoCommand());

  const currentResult = await executor.exec(`readlink "${appPath}/current" 2>/dev/null || echo "none"`);

  const releasesResult = await executor.exec(`cat "${appPath}/.shipnode/releases.json" 2>/dev/null || echo '[]'`);

  const processes = parsePm2Jlist(pm2Result.stdout, deployName);
  const system = parseSystemStats(sysResult.stdout);
  const releases = parseReleaseRecords(releasesResult.stdout);
  const currentRelease = currentResult.stdout === 'none' ? null : currentResult.stdout.trim();

  const error =
    pm2Result.exitCode !== 0 && app.appType === 'backend'
      ? 'PM2 command failed'
      : undefined;

  return {
    timestamp,
    processes,
    system,
    currentRelease,
    releases,
    error,
  };
}

export async function collectLogs(
  executor: RemoteExecutor,
  namespace: string,
  lines: number = 20,
): Promise<string> {
  const result = await executor.exec(
    `${MISE} && pm2 logs ${namespace} --lines ${lines} --nostream 2>&1 || echo "(no logs)"`,
  );
  return result.stdout;
}

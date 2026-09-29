/**
 * The existing TUI's adapter onto the observation layer.
 *
 * `MetricsCollector` observes a whole server; this flattens the single-app case
 * back into the `MetricsSnapshot` the current Ink components expect. It goes
 * away with them when the dashboard subscribes to an `ObserveSession` directly.
 */
import type { RemoteExecutor } from '../../domain/remote/executor.js';
import type { ShipnodeApp, ShipnodeConfig } from '../../shared/types.js';
import { MetricsCollector } from '../../domain/observe/collector.js';
import { parseSystemStats } from '../../domain/observe/parse.js';
import { MISE, shellQuote } from '../../domain/observe/script.js';
import type { MetricsSnapshot } from './state.js';

export { MISE, shellQuote };

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
  const collector = new MetricsCollector(executor, config.ssh.host, config);
  const server = await collector.collect({
    apps: [app],
    intervalSeconds: options.intervalSeconds,
    accessoryNames: options.accessoryNames,
  });

  const observed = server.apps[0];
  if (observed === undefined) {
    return {
      timestamp: server.timestamp,
      processes: [],
      system: server.system,
      currentRelease: null,
      releases: [],
      deployLock: server.deployLock,
      accessories: server.accessories,
      error: server.error ?? 'Monitor poll returned no data',
    };
  }

  return {
    timestamp: server.timestamp,
    processes: observed.processes,
    system: server.system,
    currentRelease: observed.currentRelease,
    releases: observed.releases,
    deployLock: server.deployLock,
    health: observed.health,
    accessories: server.accessories,
    caddy: observed.caddy,
    error: server.error ?? observed.error,
  };
}

/** A snapshot for a server that could not be reached at all. */
export function unreachableSnapshot(error: string): MetricsSnapshot {
  return {
    timestamp: new Date().toISOString(),
    processes: [],
    system: parseSystemStats(''),
    currentRelease: null,
    releases: [],
    deployLock: null,
    error,
  };
}

export async function collectLogs(
  executor: RemoteExecutor,
  namespace: string,
  lines: number = 20,
  supervisor?: 'systemd',
): Promise<string> {
  if (supervisor === 'systemd') {
    // `namespace` is a unit name when a single process is selected, or the
    // deployment namespace when tailing everything (matches its units by glob).
    const units = namespace.startsWith('shipnode-')
      ? `-u ${shellQuote(namespace)}`
      : `-u ${shellQuote(`shipnode-${namespace}`)} -u ${shellQuote(`shipnode-${namespace}-*`)}`;
    const journal = await executor.exec(
      `S=$([ "$(id -u)" = 0 ] || echo sudo); $S journalctl ${units} -n ${lines} --no-pager 2>&1 || echo "(no logs)"`,
    );
    return journal.stdout;
  }
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

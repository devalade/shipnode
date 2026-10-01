import { Result, type Result as ResultType } from 'better-result';
import { describeConvergence } from '../domain/deploy/convergence.js';
import { MetricsCollector } from '../domain/observe/collector.js';
import { parseSystemStats } from '../domain/observe/parse.js';
import { releaseNameOf, type FleetView, type ServerSnapshot } from '../domain/observe/snapshot.js';
import { configForAppResult, configForServer, getServerTargets, type ServerTarget } from '../domain/servers.js';
import { SshConnection } from '../infrastructure/ssh/connection.js';
import type { AppTargetError, ServerTargetError } from '../shared/result-errors.js';
import { UnknownServerTargetError } from '../shared/result-errors.js';
import type { ShipnodeApp, ShipnodeConfig, SshConfig } from '../shared/types.js';
import type { ObserveState, ObserveTarget } from '../services/observe/session.js';
import { ObserveSession } from '../services/observe/session.js';
import { getAccessoriesForMonitorTarget, getAppsForMonitorTarget } from './monitor/monitor-session.js';
import { ui } from './ui.js';

export interface ObserveHostPlan {
  name: string;
  ssh: SshConfig;
  apps: ShipnodeApp[];
  accessoryNames: string[];
}

export interface ObserveFilter {
  app?: string;
  on?: string;
  intervalSeconds?: number;
}

/**
 * One observation of the workspace: plan hosts, poll, close.
 *
 * Status, `--once`, and `--json` are the same use case with different printers.
 */
export async function takeSnapshot(
  config: ShipnodeConfig,
  filter: ObserveFilter = {},
): Promise<ResultType<ObserveState, AppTargetError | ServerTargetError>> {
  const hosts = planObserveHosts(config, filter);
  if (hosts.isErr()) return Result.err(hosts.error);

  const connections: SshConnection[] = [];
  const targets: ObserveTarget[] = [];
  try {
    for (const host of hosts.value) {
      targets.push(await connectHost(config, host, connections));
    }
    const session = new ObserveSession({
      targets,
      intervalSeconds: filter.intervalSeconds ?? 2,
    });
    await session.tick();
    return Result.ok(session.getState());
  } finally {
    for (const ssh of connections) ssh.disconnect();
  }
}

export function planObserveHosts(
  config: ShipnodeConfig,
  filter: ObserveFilter = {},
): ResultType<ObserveHostPlan[], AppTargetError | ServerTargetError> {
  const scoped = filter.app === undefined ? Result.ok(config) : configForAppResult(config, filter.app);
  if (scoped.isErr()) return Result.err(scoped.error);

  const selected = selectServers(scoped.value, filter.on);
  if (selected.isErr()) return Result.err(selected.error);

  const hosts: ObserveHostPlan[] = [];
  for (const target of selected.value) {
    const apps = getAppsForMonitorTarget(scoped.value, target.name);
    if (apps.isErr()) return Result.err(apps.error);
    const accessoryNames = getAccessoriesForMonitorTarget(scoped.value, target.name);
    if (accessoryNames.isErr()) return Result.err(accessoryNames.error);
    if (apps.value.length === 0 && accessoryNames.value.length === 0) continue;
    hosts.push({
      name: target.name,
      ssh: target.ssh,
      apps: apps.value,
      accessoryNames: accessoryNames.value,
    });
  }
  return Result.ok(hosts);
}

function selectServers(
  config: ShipnodeConfig,
  on: string | undefined,
): ResultType<ServerTarget[], ServerTargetError> {
  const targets = getServerTargets(config);
  if (on === undefined) return Result.ok(targets);

  const match = targets.filter((target) => target.name === on);
  if (match.length === 0) {
    const known = targets.map((target) => target.name).join(', ') || '(none)';
    return Result.err(new UnknownServerTargetError({ target: on, known }));
  }
  return Result.ok(match);
}

async function connectHost(
  config: ShipnodeConfig,
  host: ObserveHostPlan,
  connections: SshConnection[],
): Promise<ObserveTarget> {
  const ssh = new SshConnection();
  try {
    await ssh.connect(host.ssh);
    connections.push(ssh);
    return {
      observer: new MetricsCollector(ssh, host.name, configForServer(config, host.name)),
      apps: host.apps,
      accessoryNames: host.accessoryNames,
    };
  } catch (cause: unknown) {
    ssh.disconnect();
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      observer: unreachableObserver(host.name, `Failed to connect: ${message}`),
      apps: host.apps,
      accessoryNames: host.accessoryNames,
    };
  }
}

function unreachableObserver(serverName: string, message: string): ObserveTarget['observer'] {
  return {
    serverName,
    async collect(): Promise<ServerSnapshot> {
      return {
        server: serverName,
        timestamp: new Date().toISOString(),
        system: parseSystemStats(''),
        deployLock: null,
        apps: [],
        error: message,
      };
    },
  };
}

export function printObserveStatus(state: ObserveState, options: { narrowed: boolean }): void {
  for (const server of state.servers) printServer(server);
  if (options.narrowed) return;
  for (const fleet of state.fleets) {
    if (fleet.replicas.length + fleet.unreachable.length < 2) continue;
    printFleet(fleet);
  }
}

function printServer(server: ServerSnapshot): void {
  ui.heading(`Server: ${server.server}`);
  if (server.error !== undefined) {
    ui.warn(`  Unreachable: ${server.error}`);
    return;
  }

  ui.section('  System', [
    ['Load', `${server.system.load1.toFixed(2)} ${server.system.load5.toFixed(2)} ${server.system.load15.toFixed(2)}`],
    ['Memory', `${server.system.usedMem} / ${server.system.totalMem} MB`],
  ]);
  if (server.deployLock) {
    ui.warn(`  Deploy lock held since ${server.deployLock.lockedAt} (${server.deployLock.ageSeconds}s)`);
  }

  for (const app of server.apps) {
    ui.heading(`  App: ${app.app} (${app.appType})`);
    if (app.error !== undefined) {
      ui.warn(`    ${app.error}`);
      continue;
    }
    for (const process of app.processes) {
      ui.section(`    ${process.supervisor === 'systemd' ? 'systemd' : 'PM2'}: ${process.name}`, [
        ['Status', process.status],
        ['PID', String(process.pid ?? 'N/A')],
        ['Restarts', String(process.restarts)],
        ['Memory', `${process.memory} MB`],
        ['CPU', `${process.cpu}%`],
      ]);
    }
    const release = releaseNameOf(app);
    if (release) ui.success(`    Current release: ${release}`);
    else ui.warn('    No active release');
    if (app.releases.length > 0) {
      ui.section(
        '    Recent Releases',
        app.releases.slice(0, 5).map((record, index) => [`#${index + 1}`, record.timestamp]),
      );
    }
    if (app.health) {
      ui.section('    Health', [
        ['Status', app.health.status],
        ['HTTP', String(app.health.httpCode)],
        ['Ms', String(app.health.responseMs)],
      ]);
    }
  }
}

function printFleet(fleet: FleetView): void {
  ui.heading(`Fleet: ${fleet.app}`);
  ui.section(
    '  Replicas',
    fleet.replicas.map((replica) => [
      replica.server,
      replica.reachable ? (releaseNameOf(replica.snapshot) ?? 'no release') : 'unreachable',
    ]),
  );
  if (fleet.unreachable.length > 0) {
    ui.warn(`  Unreachable: ${fleet.unreachable.join(', ')}`);
  }
  if (fleet.convergence.converged && fleet.unreachable.length === 0) {
    ui.success(`  All ${fleet.replicas.length} replicas on ${fleet.convergence.releases[0] ?? 'no release'}`);
    return;
  }
  const observations = fleet.replicas.map((replica) => ({
    server: replica.server,
    release: releaseNameOf(replica.snapshot),
  }));
  for (const line of describeConvergence(fleet.app, observations, fleet.convergence)) {
    ui.warn(`  ${line}`);
  }
}

export function observeStateJson(state: ObserveState): string {
  return `${JSON.stringify(
    {
      servers: state.servers,
      fleets: state.fleets,
      events: state.events,
      lastUpdate: state.lastUpdate,
    },
    null,
    2,
  )}\n`;
}

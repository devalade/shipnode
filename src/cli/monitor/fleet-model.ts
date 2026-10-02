import type { AppSnapshot, FleetView, ServerSnapshot } from '../../domain/observe/snapshot.js';
import { releaseNameOf } from '../../domain/observe/snapshot.js';
import type { HealthInfo, SystemInfo } from '../../domain/observe/types.js';
import type { ObserveEvent } from '../../services/observe/events.js';
import type { MetricsSnapshot } from './state.js';

/**
 * One line of the fleet table: one app on one server.
 *
 * Derived from `FleetView`s, so a replica the poll could not reach still gets a
 * row - it is exactly the row the operator needs to see.
 */
export interface FleetRow {
  /** Stable across ticks, so a selection survives a refresh. */
  key: string;
  app: string;
  appType: 'backend' | 'frontend';
  server: string;
  reachable: boolean;
  error?: string;
  release: string | null;
  /** `behind` marks a replica not on the newest release while the fleet is split. */
  releaseState: 'current' | 'behind' | 'none' | 'unknown';
  online: number;
  total: number;
  cpu: number;
  memoryMb: number;
  restarts: number;
  health?: HealthInfo;
  /** Whether the app runs on more than one server, which decides if skew is meaningful. */
  replicated: boolean;
  snapshot?: AppSnapshot;
  system?: SystemInfo;
}

export function buildFleetRows(fleets: readonly FleetView[]): FleetRow[] {
  const rows: FleetRow[] = [];
  for (const fleet of fleets) {
    const replicated = fleet.replicas.length + fleet.unreachable.length > 1;
    const newest = fleet.convergence.releases[0];

    for (const replica of fleet.replicas) {
      const snapshot = replica.snapshot;
      const release = releaseNameOf(snapshot);
      const processes = snapshot.processes;
      rows.push({
        key: rowKey(fleet.app, replica.server),
        app: fleet.app,
        appType: fleet.appType,
        server: replica.server,
        reachable: replica.reachable,
        error: snapshot.error,
        release,
        releaseState:
          release === null ? 'none' : fleet.convergence.converged || release === newest ? 'current' : 'behind',
        online: processes.filter((p) => p.status === 'online').length,
        total: processes.length,
        cpu: processes.reduce((sum, p) => sum + p.cpu, 0),
        memoryMb: processes.reduce((sum, p) => sum + p.memory, 0),
        restarts: processes.reduce((sum, p) => sum + p.restarts, 0),
        health: snapshot.health,
        replicated,
        snapshot,
        system: replica.system,
      });
    }

    for (const server of fleet.unreachable) {
      rows.push({
        key: rowKey(fleet.app, server),
        app: fleet.app,
        appType: fleet.appType,
        server,
        reachable: false,
        release: null,
        releaseState: 'unknown',
        online: 0,
        total: 0,
        cpu: 0,
        memoryMb: 0,
        restarts: 0,
        replicated,
      });
    }
  }
  return rows;
}

/** NUL-joined: app and server names are free-form, so a printable separator could collide. */
export function rowKey(app: string, server: string): string {
  return `${app}\u0000${server}`;
}

export interface FleetHeadline {
  tone: 'ok' | 'warn' | 'bad';
  text: string;
}

/** One sentence per app: is the fleet agreed on a release, and can every replica be seen? */
export function describeFleet(fleet: FleetView): FleetHeadline {
  const { convergence, unreachable, replicas } = fleet;
  const total = replicas.length + unreachable.length;
  if (unreachable.length > 0) {
    return { tone: 'bad', text: `${unreachable.length}/${total} unreachable: ${unreachable.join(', ')}` };
  }
  if (convergence.releases.length > 1) {
    return { tone: 'bad', text: `split across ${convergence.releases.length} releases - a roll stopped partway` };
  }
  if (convergence.undeployed.length > 0) {
    return { tone: 'warn', text: `no release on ${convergence.undeployed.join(', ')}` };
  }
  return { tone: 'ok', text: total > 1 ? `converged on ${convergence.releases[0] ?? 'no release'}` : 'ok' };
}

/** The flattened shape the per-app panels still take. */
export function toMetricsSnapshot(server: ServerSnapshot, app: AppSnapshot): MetricsSnapshot {
  return {
    timestamp: server.timestamp,
    processes: app.processes,
    system: server.system,
    currentRelease: app.currentRelease,
    releases: app.releases,
    deployLock: server.deployLock,
    health: app.health,
    accessories: server.accessories,
    caddy: app.caddy,
    error: server.error ?? app.error,
  };
}

/** Wording for an event; colour is the renderer's business. */
export function describeEvent(event: ObserveEvent): { tone: 'ok' | 'warn' | 'bad' | 'info'; text: string } {
  switch (event.kind) {
    case 'health-failing':
      return { tone: 'bad', text: `${event.app} on ${event.server}: health check failing (${event.streak} consecutive probes)` };
    case 'health-recovered':
      return { tone: 'ok', text: `${event.app} on ${event.server}: health check recovered` };
    case 'server-unreachable':
      return { tone: 'bad', text: `${event.server} unreachable: ${event.message}` };
    case 'server-recovered':
      return { tone: 'ok', text: `${event.server} reachable again` };
    case 'app-error':
      return { tone: 'bad', text: `${event.app} on ${event.server}: ${event.message}` };
    case 'notice':
      return { tone: 'info', text: event.message };
  }
}

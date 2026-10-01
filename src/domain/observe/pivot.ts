import { assessConvergence, type ReplicaObservation } from '../deploy/convergence.js';
import { releaseNameOf, type AppSnapshot, type FleetView, type ReplicaView, type ServerSnapshot } from './snapshot.js';

/**
 * Turn server-shaped observations into app-shaped views.
 *
 * Collection is server-shaped — one round trip per host — but release skew
 * lives *between* hosts, so it is invisible until the snapshots are pivoted.
 * This is a pure function over already-collected data: no I/O, no config
 * lookups, so `status`, the live dashboard, and `--json` can all derive the
 * fleet picture from the same tick without polling again.
 */
export function pivotByApp(snapshots: ServerSnapshot[]): FleetView[] {
  const byApp = new Map<string, ReplicaView[]>();
  const order: string[] = [];

  for (const server of snapshots) {
    for (const app of server.apps) {
      const replicas = byApp.get(app.app);
      if (replicas === undefined) {
        byApp.set(app.app, [toReplica(server, app)]);
        order.push(app.app);
      } else {
        replicas.push(toReplica(server, app));
      }
    }
  }

  // A server whose poll failed reports no apps at all. When the caller recorded
  // which apps it was planned to run, the failure is blamed on exactly those
  // apps — and an app whose every server failed still gets a view, so it cannot
  // vanish. Without that record (an older snapshot shape) the server is blamed
  // on every app another replica proves exists: enough to stop a partial
  // observation from reading as a converged fleet, without inventing apps.
  const unreachableByApp = new Map<string, string[]>();
  const plannedType = new Map<string, FleetView['appType']>();
  const unattributed: string[] = [];
  for (const server of snapshots) {
    if (server.error === undefined) continue;
    if (server.plannedApps === undefined) {
      unattributed.push(server.server);
      continue;
    }
    for (const planned of server.plannedApps) {
      const servers = unreachableByApp.get(planned.app);
      if (servers === undefined) unreachableByApp.set(planned.app, [server.server]);
      else servers.push(server.server);
      plannedType.set(planned.app, planned.appType);
      if (!byApp.has(planned.app)) {
        byApp.set(planned.app, []);
        order.push(planned.app);
      }
    }
  }

  return order.map((appName) => {
    const replicas = byApp.get(appName) ?? [];
    const observations: ReplicaObservation[] = replicas.map((replica) => ({
      server: replica.server,
      release: releaseNameOf(replica.snapshot),
    }));

    return {
      app: appName,
      appType: replicas[0]?.snapshot.appType ?? plannedType.get(appName) ?? 'backend',
      replicas,
      convergence: assessConvergence(observations),
      unreachable: [...(unreachableByApp.get(appName) ?? []), ...(replicas.length > 0 ? unattributed : [])],
    };
  });
}

function toReplica(server: ServerSnapshot, snapshot: AppSnapshot): ReplicaView {
  return {
    server: server.server,
    snapshot,
    system: server.system,
    reachable: server.error === undefined,
  };
}

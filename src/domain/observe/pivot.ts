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

  // A server whose poll failed reports no apps at all, so it cannot say which
  // apps it was meant to be running. It is attributed to every app another
  // replica proves exists — enough to stop a partial observation from reading
  // as a converged fleet, without inventing apps for a host we never reached.
  const unreachable = snapshots.flatMap((server) => (server.error === undefined ? [] : [server.server]));

  return order.map((appName) => {
    const replicas = byApp.get(appName) ?? [];
    const observations: ReplicaObservation[] = replicas.map((replica) => ({
      server: replica.server,
      release: releaseNameOf(replica.snapshot),
    }));

    return {
      app: appName,
      appType: replicas[0]?.snapshot.appType ?? 'backend',
      replicas,
      convergence: assessConvergence(observations),
      unreachable,
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

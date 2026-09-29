import type {
  AccessoryInfo,
  CaddyInfo,
  DeployLockInfo,
  HealthInfo,
  ProcessInfo,
  ReleaseRecord,
  SystemInfo,
} from './types.js';
import type { FleetConvergence } from '../deploy/convergence.js';

/**
 * What one poll of one server established.
 *
 * Collection is server-shaped because that is the shape of the round trip: one
 * SSH connection, one script, one set of host-level facts. An app-shaped
 * snapshot would report the same load average once per app on the box.
 */
export interface ServerSnapshot {
  /** The host string — the server's identity everywhere, per ADR-0008. */
  server: string;
  timestamp: string;
  system: SystemInfo;
  /** Absent on polls that skipped the (heavier) accessories section — carry the previous value forward. */
  accessories?: AccessoryInfo[];
  /** Server-scoped: the lock lives at `{remotePath}/.shipnode/deploy.lock`, not under an app. */
  deployLock: DeployLockInfo | null;
  apps: AppSnapshot[];
  /** Whole-server failure — unreachable, timed out, script produced nothing. */
  error?: string;
}

/** The app-scoped slice of one server's poll. */
export interface AppSnapshot {
  app: string;
  appType: 'backend' | 'frontend';
  processes: ProcessInfo[];
  currentRelease: string | null;
  releases: ReleaseRecord[];
  /** Absent when the app has no enabled HTTP health check or the probe produced no data. */
  health?: HealthInfo;
  /** Present only for frontend apps served by Caddy. */
  caddy?: CaddyInfo;
  /** Per-app failure — PM2 down for this namespace — leaving the rest of the server readable. */
  error?: string;
}

/** One app seen across every server it runs on. Derived, never collected. */
export interface FleetView {
  app: string;
  appType: 'backend' | 'frontend';
  replicas: ReplicaView[];
  /**
   * Convergence over the replicas that actually answered. A partial
   * observation cannot prove convergence, so `unreachable` must be read
   * alongside it — the same rule `status` already applies when `--on`
   * narrows a run to one server.
   */
  convergence: FleetConvergence;
  /** Servers that should be running this app but could not be reached this tick. */
  unreachable: string[];
}

export interface ReplicaView {
  server: string;
  snapshot: AppSnapshot;
  system: SystemInfo;
  /** False when the server-level poll failed; `snapshot` is then a placeholder. */
  reachable: boolean;
}

/** The release directory name, which is what is comparable between replicas. */
export function releaseNameOf(snapshot: AppSnapshot): string | null {
  return snapshot.currentRelease?.split('/').pop() ?? null;
}

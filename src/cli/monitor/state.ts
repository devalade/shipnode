/**
 * The existing TUI's view of the observation layer.
 *
 * Everything here now lives under `domain/observe` and `services/observe`; this
 * module survives as the seam the current Ink components still import, and goes
 * away with them when the dashboard is rebuilt on `ObserveSession`.
 */
export * from '../../domain/observe/types.js';
export * from '../../domain/observe/parse.js';
export { MetricsHistory } from '../../services/observe/history.js';

import type {
  AccessoryInfo,
  CaddyInfo,
  DeployLockInfo,
  HealthInfo,
  ProcessInfo,
  ReleaseRecord,
  SystemInfo,
} from '../../domain/observe/types.js';

/**
 * One app on one server, flattened.
 *
 * The observation layer keeps host-level facts (`system`, `accessories`,
 * `deployLock`) on the server and app-level facts on the app, because a box
 * hosting three apps has one load average rather than three. This shape
 * predates that split and is kept only for the components below it.
 */
export interface MetricsSnapshot {
  timestamp: string;
  processes: ProcessInfo[];
  system: SystemInfo;
  currentRelease: string | null;
  releases: ReleaseRecord[];
  deployLock: DeployLockInfo | null;
  /** Absent when the app has no enabled HTTP health check or the probe produced no data. */
  health?: HealthInfo;
  /** Absent on polls that skipped the (heavier) accessories section — carry the previous value forward. */
  accessories?: AccessoryInfo[];
  /** Present only for frontend apps served by Caddy. */
  caddy?: CaddyInfo;
  error?: string;
}

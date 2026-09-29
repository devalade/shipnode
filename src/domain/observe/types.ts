/**
 * The vocabulary of a single observation.
 *
 * These are the facts a poll can establish about a host and the apps on it.
 * They carry no scope of their own — `snapshot.ts` decides which belong to a
 * server and which to an app.
 */

export interface ProcessInfo {
  name: string;
  /** Supervisor-level name: the PM2 process name, or the systemd unit for watt. */
  pm2Name: string;
  /** Absent means PM2. `systemd` marks a unit of the watt runtime. */
  supervisor?: 'systemd';
  pid: number | null;
  status: string;
  cpu: number;
  memory: number;
  uptime: number;
  restarts: number;
  execMode: 'cluster' | 'fork' | 'threads' | 'unknown';
  instances: number;
  unstableRestarts: number;
  nodeVersion?: string;
  exitCode: number | null;
}

export interface SystemInfo {
  load1: number;
  load5: number;
  load15: number;
  cores: number;
  totalMem: number;
  usedMem: number;
  totalDisk: number;
  usedDisk: number;
  uptime: number;
}

/** CPU utilisation as a 0–1 fraction: 1-minute load normalised by core count. */
export function systemCpuPercent(system: SystemInfo): number {
  const load = system.load1 / Math.max(system.cores, 1);
  return Math.max(0, Math.min(1, load));
}

export interface DeployLockInfo {
  lockedAt: string;
  ageSeconds: number;
}

export interface HealthInfo {
  status: 'ok' | 'fail';
  httpCode: number;
  responseMs: number;
}

/**
 * Consecutive-failure streak for the HTTP health probe. A poll without probe
 * data (health check disabled or probe produced nothing) leaves the streak
 * untouched — only a real `ok` result clears it.
 */
export function nextHealthFailStreak(previous: number, health: HealthInfo | undefined): number {
  if (health === undefined) return previous;
  return health.status === 'fail' ? previous + 1 : 0;
}

export interface AccessoryInfo {
  name: string;
  status: string;
  health: string;
  image: string;
}

export interface CaddyRequest {
  status: number;
  method: string;
  uri: string;
  ms: number;
}

export interface CaddyInfo {
  serviceActive: boolean;
  total: number;
  ok2xx: number;
  err4xx: number;
  err5xx: number;
  recent: CaddyRequest[];
}

export interface ReleaseRecord {
  timestamp: string;
  status: string;
  duration: number;
  gitCommit?: string;
}

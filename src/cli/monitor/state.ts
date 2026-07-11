export interface ProcessInfo {
  name: string;
  pm2Name: string;
  pid: number | null;
  status: string;
  cpu: number;
  memory: number;
  uptime: number;
  restarts: number;
  execMode: 'cluster' | 'fork' | 'unknown';
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

export class MetricsHistory {
  cpu: number[] = [];
  memory: number[] = [];
  responseMs: number[] = [];

  constructor(private maxEntries: number = 60) {}

  push(snapshot: MetricsSnapshot): void {
    const avgCpu = snapshot.processes.reduce((s, p) => s + p.cpu, 0) / Math.max(snapshot.processes.length, 1);
    const avgMem = snapshot.processes.reduce((s, p) => s + p.memory, 0) / Math.max(snapshot.processes.length, 1);

    this.cpu.push(avgCpu);
    this.memory.push(avgMem);
    if (snapshot.health !== undefined) this.responseMs.push(snapshot.health.responseMs);

    if (this.cpu.length > this.maxEntries) this.cpu.shift();
    if (this.memory.length > this.maxEntries) this.memory.shift();
    if (this.responseMs.length > this.maxEntries) this.responseMs.shift();
  }

  clear(): void {
    this.cpu = [];
    this.memory = [];
    this.responseMs = [];
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  // SAFETY: Runtime checks above establish a non-null plain object shape for indexed boundary parsing.
  return value as Record<string, unknown>;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function parsePm2Jlist(stdout: string, namespace: string): ProcessInfo[] {
  try {
    const raw: unknown = JSON.parse(stdout.trim());
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => parsePm2Entry(entry, namespace));
  } catch {
    return [];
  }
}

function parsePm2Entry(entry: unknown, namespace: string): ProcessInfo[] {
  const item = readRecord(entry);
  if (item === null) return [];
  const name = readString(item.name);
  if (name === undefined) return [];
  if (!belongsToNamespace(name, namespace)) return [];

  const pm2Env = readRecord(item.pm2_env);
  const monit = readRecord(item.monit);
  const memory = readNumber(monit?.memory);

  return [{
    name: resolveShortName(name, namespace),
    pm2Name: name,
    pid: readNumber(item.pid) ?? null,
    status: readString(pm2Env?.status) ?? 'unknown',
    cpu: readNumber(monit?.cpu) ?? 0,
    memory: memory === undefined ? 0 : Math.round(memory / (1024 * 1024)),
    uptime: readNumber(pm2Env?.pm_uptime) ?? 0,
    restarts: readNumber(pm2Env?.restart_time) ?? 0,
    execMode: parseExecMode(readString(pm2Env?.exec_mode)),
    instances: readNumber(pm2Env?.instances) ?? 1,
    unstableRestarts: readNumber(pm2Env?.unstable_restarts) ?? 0,
    nodeVersion: readString(pm2Env?.node_version),
    exitCode: readNumber(pm2Env?.exit_code) ?? null,
  }];
}

function parseExecMode(raw: string | undefined): ProcessInfo['execMode'] {
  if (raw === 'cluster_mode') return 'cluster';
  if (raw === 'fork_mode') return 'fork';
  return 'unknown';
}

function belongsToNamespace(pm2Name: string, namespace: string): boolean {
  if (namespace === '') return true;
  return pm2Name === namespace || pm2Name.startsWith(`${namespace}-`);
}

export function parseSystemStats(stdout: string): SystemInfo {
  const lines = stdout.trim().split('\n').flatMap((line) => line ? [line] : []);
  const result: SystemInfo = {
    load1: 0,
    load5: 0,
    load15: 0,
    cores: 1,
    totalMem: 0,
    usedMem: 0,
    totalDisk: 0,
    usedDisk: 0,
    uptime: 0,
  };

  for (const line of lines) {
    if (line.startsWith('mem:')) {
      const parts = line.split(/[:\s]+/);
      result.totalMem = parseInt(parts[1] ?? '0', 10) || 0;
      result.usedMem = parseInt(parts[2] ?? '0', 10) || 0;
    } else if (line.startsWith('load:')) {
      const parts = line.split(/[:\s]+/);
      result.load1 = parseFloat(parts[1] ?? '0') || 0;
      result.load5 = parseFloat(parts[2] ?? '0') || 0;
      result.load15 = parseFloat(parts[3] ?? '0') || 0;
    } else if (line.startsWith('cores:')) {
      result.cores = parseInt(line.split(/[:\s]+/)[1] ?? '1', 10) || 1;
    } else if (line.startsWith('uptime:')) {
      result.uptime = parseInt(line.split(/[:\s]+/)[1] ?? '0', 10) || 0;
    } else if (line.startsWith('disk:')) {
      const parts = line.split(/[:\s]+/);
      result.totalDisk = parseInt(parts[1] ?? '0', 10) || 0;
      result.usedDisk = parseInt(parts[2] ?? '0', 10) || 0;
    }
  }

  return result;
}

const SECTION_MARKER = /^@@SHIPNODE:([a-z0-9-]+)@@$/;

/**
 * Split the combined monitor command output into named sections. Missing or
 * empty sections simply do not appear in the map — callers treat absence as
 * "no data", never as an error.
 */
export function splitSections(stdout: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (current !== null) sections.set(current, buffer.join('\n').trim());
  };

  for (const line of stdout.split('\n')) {
    const match = SECTION_MARKER.exec(line.trim());
    if (match !== null) {
      flush();
      current = match[1];
      buffer = [];
    } else if (current !== null) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

export function parseDeployLock(section: string): DeployLockInfo | null {
  const trimmed = section.trim();
  if (trimmed === '' || trimmed === 'none') return null;

  const parts = trimmed.split(/\s+/);
  const age = parseInt(parts[parts.length - 1] ?? '', 10);
  if (Number.isNaN(age)) return null;

  return {
    lockedAt: parts.slice(0, -1).join(' '),
    ageSeconds: Math.max(age, 0),
  };
}

export function parseHealthProbe(section: string): HealthInfo | null {
  const trimmed = section.trim();
  if (trimmed === '') return null;

  const parts = trimmed.split(/\s+/);
  const httpCode = parseInt(parts[0] ?? '', 10);
  const responseMs = parseInt(parts[1] ?? '', 10);
  if (Number.isNaN(httpCode) || Number.isNaN(responseMs)) return null;

  return {
    status: httpCode >= 200 && httpCode < 400 ? 'ok' : 'fail',
    httpCode,
    responseMs,
  };
}

export function parseAccessoryStatus(section: string): AccessoryInfo[] {
  return section.split('\n').flatMap((line) => {
    const trimmed = line.trim();
    if (trimmed === '') return [];

    const parts = trimmed.split('|');
    if (parts.length < 4) return [];

    const [rawName, status, health, image] = parts;
    return [{
      name: rawName.replace(/^\/?(?:shipnode-)?/, ''),
      status,
      health: health === '' || health === '<no value>' ? '-' : health,
      image,
    }];
  });
}

export function parseCaddyInfo(statusSection: string, logSection: string): CaddyInfo {
  const info: CaddyInfo = {
    serviceActive: statusSection.trim() === 'active',
    total: 0,
    ok2xx: 0,
    err4xx: 0,
    err5xx: 0,
    recent: [],
  };

  for (const line of logSection.split('\n')) {
    const request = parseCaddyLogLine(line);
    if (request === null) continue;
    info.total += 1;
    if (request.status >= 500) info.err5xx += 1;
    else if (request.status >= 400) info.err4xx += 1;
    else info.ok2xx += 1;
    info.recent.push(request);
  }

  info.recent = info.recent.slice(-5);
  return info;
}

function parseCaddyLogLine(line: string): CaddyRequest | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;

  try {
    const raw: unknown = JSON.parse(trimmed);
    const record = readRecord(raw);
    if (record === null) return null;

    const status = readNumber(record.status);
    if (status === undefined) return null;

    const request = readRecord(record.request);
    const duration = readNumber(record.duration);
    return {
      status,
      method: readString(request?.method) ?? '',
      uri: readString(request?.uri) ?? '',
      ms: duration === undefined ? 0 : Math.round(duration * 1000),
    };
  } catch {
    return null;
  }
}

export function parseReleaseRecords(stdout: string): ReleaseRecord[] {
  try {
    const records: ReleaseRecord[] = JSON.parse(stdout.trim());
    return records.reverse().slice(0, 10);
  } catch {
    return [];
  }
}

function resolveShortName(pm2Name: string, namespace: string): string {
  if (pm2Name === namespace) return pm2Name;
  if (pm2Name.startsWith(`${namespace}-`)) return pm2Name.slice(namespace.length + 1);
  return pm2Name;
}

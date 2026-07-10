export interface ProcessInfo {
  name: string;
  pm2Name: string;
  pid: number | null;
  status: string;
  cpu: number;
  memory: number;
  uptime: number;
  restarts: number;
}

export interface SystemInfo {
  cpuLoad: number;
  totalMem: number;
  usedMem: number;
  totalDisk: number;
  usedDisk: number;
  uptime: number;
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

    if (this.cpu.length > this.maxEntries) this.cpu.shift();
    if (this.memory.length > this.maxEntries) this.memory.shift();
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
  }];
}

function belongsToNamespace(pm2Name: string, namespace: string): boolean {
  if (namespace === '') return true;
  return pm2Name === namespace || pm2Name.startsWith(`${namespace}-`);
}

export function parseSystemStats(stdout: string): SystemInfo {
  const lines = stdout.trim().split('\n').flatMap((line) => line ? [line] : []);
  const result: SystemInfo = {
    cpuLoad: 0,
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
      result.cpuLoad = parseFloat(line.split(/[:\s]+/)[1] ?? '0') || 0;
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

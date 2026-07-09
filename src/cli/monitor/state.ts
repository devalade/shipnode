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

interface Pm2JlistEntry {
  name: string;
  pid?: number;
  pm2_env?: {
    status?: string;
    pm_uptime?: number;
    restart_time?: number;
  };
  monit?: {
    memory: number;
    cpu: number;
  };
}

export function parsePm2Jlist(stdout: string, namespace: string): ProcessInfo[] {
  try {
    const entries: Pm2JlistEntry[] = JSON.parse(stdout.trim());
    return entries.map((e) => ({
      name: resolveShortName(e.name, namespace),
      pm2Name: e.name,
      pid: e.pid ?? null,
      status: e.pm2_env?.status ?? 'unknown',
      cpu: e.monit?.cpu ?? 0,
      memory: e.monit?.memory != null ? Math.round(e.monit.memory / (1024 * 1024)) : 0,
      uptime: e.pm2_env?.pm_uptime ?? 0,
      restarts: e.pm2_env?.restart_time ?? 0,
    }));
  } catch {
    return [];
  }
}

export function parseSystemStats(stdout: string): SystemInfo {
  const lines = stdout.trim().split('\n').filter(Boolean);
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

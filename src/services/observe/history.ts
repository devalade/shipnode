import type { AppSnapshot } from '../../domain/observe/snapshot.js';

/**
 * A rolling window of one app's numbers on one server, for sparklines.
 *
 * Averaged across processes rather than kept per-process: the window exists to
 * show a trend at a glance, and a per-process series would need a legend to be
 * readable at sparkline size.
 */
export class MetricsHistory {
  cpu: number[] = [];
  memory: number[] = [];
  responseMs: number[] = [];

  constructor(private maxEntries: number = 60) {}

  push(snapshot: Pick<AppSnapshot, 'processes' | 'health'>): void {
    const count = Math.max(snapshot.processes.length, 1);
    this.cpu.push(snapshot.processes.reduce((sum, p) => sum + p.cpu, 0) / count);
    this.memory.push(snapshot.processes.reduce((sum, p) => sum + p.memory, 0) / count);
    if (snapshot.health !== undefined) this.responseMs.push(snapshot.health.responseMs);

    this.trim(this.cpu);
    this.trim(this.memory);
    this.trim(this.responseMs);
  }

  private trim(series: number[]): void {
    if (series.length > this.maxEntries) series.shift();
  }

  clear(): void {
    this.cpu = [];
    this.memory = [];
    this.responseMs = [];
  }
}

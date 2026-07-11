const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;
const BAR_FILL = '█';
const BAR_EMPTY = '░';

export type ThresholdColor = 'green' | 'yellow' | 'red';

export function thresholdColor(percent: number): ThresholdColor {
  if (percent < 0.6) return 'green';
  if (percent < 0.85) return 'yellow';
  return 'red';
}

export interface GaugeSpec {
  bar: string;
  color: ThresholdColor;
}

export function buildGauge(percent: number, width: number): GaugeSpec {
  const clamped = Math.max(0, Math.min(1, percent));
  const filled = Math.round(clamped * width);
  return {
    bar: BAR_FILL.repeat(filled) + BAR_EMPTY.repeat(Math.max(0, width - filled)),
    color: thresholdColor(percent),
  };
}

export interface SparkPoint {
  char: string;
  color: ThresholdColor;
}

export function buildSparkline(values: number[], width: number): SparkPoint[] {
  if (values.length === 0 || width <= 0) return [];

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return sampleArray(values, width).map((value) => {
    const idx = Math.min(Math.round(((value - min) / range) * 7), 7);
    return {
      char: SPARK_CHARS[idx],
      color: idx < 2 ? 'green' : idx < 5 ? 'yellow' : 'red',
    };
  });
}

export function statusColor(status: string): string {
  switch (status) {
    case 'online':
      return 'green';
    case 'stopped':
    case 'stopping':
      return 'yellow';
    case 'errored':
      return 'red';
    default:
      return 'gray';
  }
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}m`);
  return parts.join(' ');
}

export function formatBytes(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

export function sampleArray(arr: number[], n: number): number[] {
  if (arr.length <= n) return arr;
  const step = (arr.length - 1) / (n - 1);
  const result: number[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round(i * step);
    result.push(arr[Math.min(idx, arr.length - 1)]);
  }
  return result;
}

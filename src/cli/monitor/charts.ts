import chalk from 'chalk';

const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;
const BAR_FILL = '█';
const BAR_EMPTY = '░';

export function sparkline(values: number[], width: number): string {
  if (values.length === 0 || width <= 0) return '';
  if (values.length === 1) return SPARK_CHARS[Math.min(Math.round(values[0]), 7)].repeat(width);

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = range / 7;

  const sampled = sampleArray(values, width);
  return sampled.map((v) => SPARK_CHARS[Math.min(Math.round((v - min) / step), 7)]).join('');
}

export function gauge(percent: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, percent));
  const filled = Math.round(clamped * width);
  const empty = width - filled;

  const color = percent < 0.6 ? chalk.green : percent < 0.85 ? chalk.yellow : chalk.red;
  const bar = BAR_FILL.repeat(filled) + BAR_EMPTY.repeat(Math.max(0, empty));
  return color(bar);
}

export interface BarItem {
  label: string;
  value: number;
}

export function barChart(items: BarItem[], width: number): string {
  if (items.length === 0) return '';
  const maxVal = Math.max(...items.map((i) => i.value), 1);
  const barWidth = Math.max(width - 20, 10);
  const labelPad = Math.max(...items.map((i) => i.label.length)) + 1;

  return items
    .map((item) => {
      const pct = item.value / maxVal;
      const filled = Math.round(pct * barWidth);
      const bar = BAR_FILL.repeat(filled) + BAR_EMPTY.repeat(Math.max(0, barWidth - filled));
      const color = item.value >= maxVal * 0.8 ? chalk.yellow : item.value >= maxVal * 0.5 ? chalk.cyan : chalk.dim;
      return `${item.label.padEnd(labelPad)} ${color(bar)} ${String(item.value)}`;
    })
    .join('\n');
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

export function statusDot(status: string): string {
  switch (status) {
    case 'online':
      return chalk.green('●');
    case 'stopped':
    case 'stopping':
      return chalk.yellow('●');
    case 'errored':
      return chalk.red('●');
    default:
      return chalk.dim('●');
  }
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

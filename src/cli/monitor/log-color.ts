import { detectLevel, type LogLevel } from '../../domain/observe/log-line.js';

/**
 * Severity color for a raw log line; the classification itself lives in the
 * domain so the viewer, the filters and the CLI agree on what an error is.
 */
export function logLineColor(line: string): 'red' | 'yellow' | undefined {
  return levelColor(detectLevel(line));
}

export function levelColor(level: LogLevel | undefined): 'red' | 'yellow' | undefined {
  if (level === 'error') return 'red';
  if (level === 'warn') return 'yellow';
  return undefined;
}

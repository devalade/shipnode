/**
 * The monitor's whole visual vocabulary.
 *
 * Chrome is neutral and stays out of the way; colour is spent on state, so a
 * red thing on screen always means something is wrong. No background fills:
 * the terminal's own background is respected, which keeps the dashboard
 * readable on light themes too.
 */
export const color = {
  /** Brand accent: titles, the selection marker. Never state. */
  accent: '#d6a85d',
  border: 'gray',
  ok: 'green',
  warn: 'yellow',
  bad: 'red',
  info: 'cyan',
} as const;

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';

/** A tone's colour; `muted` maps to undefined so callers pair it with `dimColor`. */
export function toneColor(tone: Tone): string | undefined {
  return tone === 'muted' ? undefined : color[tone];
}

export const glyph = {
  ok: '●',
  degraded: '◐',
  down: '○',
  unknown: '◌',
  select: '❯',
  alert: '▲',
  sep: '·',
  crumb: '›',
  brand: '◆',
  pause: '⏸',
} as const;

/** Status dot for a supervisor process state. */
export function processTone(status: string): Tone {
  if (status === 'online') return 'ok';
  if (status === 'errored') return 'bad';
  if (status === 'stopped' || status === 'stopping' || status === 'launching') return 'warn';
  return 'muted';
}

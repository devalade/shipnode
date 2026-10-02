import { LOG_LEVEL_RANK, type LogLevel, type LogLine } from './log-line.js';

/**
 * What the viewer wants to see. Applied locally to the buffer, so changing a
 * filter never reconnects anything and never loses a line that was merely
 * hidden.
 *
 * `null` means "all" for the single-select dimensions.
 */
export interface LogFilter {
  server: string | null;
  app: string | null;
  process: string | null;
  /** Show this level and above; null shows everything. */
  minLevel: LogLevel | null;
  /** Raw query as typed: plain text, or `/regex/` with optional `i` flag. */
  query: string;
  /** Matching lines are kept and the rest dropped (`hide`), or the rest only faded (`dim`). */
  mode: 'hide' | 'dim';
}

export const EMPTY_LOG_FILTER: LogFilter = {
  server: null,
  app: null,
  process: null,
  minLevel: null,
  query: '',
  mode: 'hide',
};

export type LogMatcher = (text: string) => boolean;

/**
 * Compile a query. `/pattern/` and `/pattern/i` are regular expressions;
 * anything else is a case-insensitive substring, because that is what a person
 * typing a word into a log viewer means. A leading `!` negates either form.
 * An unfinished or invalid regex is reported, not thrown, since it is
 * re-evaluated on every keystroke.
 */
export function compileQuery(raw: string): { matcher: LogMatcher | null; error?: string } {
  const negated = raw.startsWith('!') && raw.length > 1;
  const body = negated ? raw.slice(1) : raw;
  if (body === '') return { matcher: null };

  const asRegex = /^\/(.+)\/([i]?)$/.exec(body);
  let test: LogMatcher;
  if (asRegex !== null) {
    try {
      const pattern = new RegExp(asRegex[1], asRegex[2] === 'i' ? 'i' : '');
      test = (text) => pattern.test(text);
    } catch (cause: unknown) {
      return { matcher: null, error: cause instanceof Error ? cause.message : 'invalid regex' };
    }
  } else {
    const needle = body.toLowerCase();
    test = (text) => text.toLowerCase().includes(needle);
  }
  return { matcher: negated ? (text) => !test(text) : test };
}

/** A line's verdict against every filter dimension except the text query. */
function matchesScope(line: LogLine, filter: LogFilter): boolean {
  if (filter.server !== null && line.server !== filter.server) return false;
  if (filter.app !== null && line.app !== filter.app) return false;
  if (filter.process !== null && line.process !== filter.process) return false;
  if (filter.minLevel !== null && LOG_LEVEL_RANK[line.level] < LOG_LEVEL_RANK[filter.minLevel]) return false;
  return true;
}

export interface FilteredLog {
  lines: LogLine[];
  /** Lines the text query matched (all of `lines` in hide mode). Drives highlighting in dim mode. */
  matched: Set<number>;
  queryError?: string;
}

/**
 * Apply a filter. In `dim` mode the query does not remove lines, it only marks
 * which ones matched, so the surrounding context stays readable.
 */
export function applyLogFilter(lines: readonly LogLine[], filter: LogFilter): FilteredLog {
  const { matcher, error } = compileQuery(filter.query);
  const kept: LogLine[] = [];
  const matched = new Set<number>();

  for (const line of lines) {
    if (!matchesScope(line, filter)) continue;
    const hit = matcher === null || matcher(line.text);
    if (hit) matched.add(line.id);
    if (hit || filter.mode === 'dim') kept.push(line);
  }
  return { lines: kept, matched, queryError: error };
}

export type LevelCounts = Record<LogLevel, number>;

/**
 * Per-level totals under every filter except the level itself, so the counts
 * answer "how many errors would I see if I switched to error" instead of
 * collapsing to zero the moment the filter is set to something else.
 */
export function countLevels(lines: readonly LogLine[], filter: LogFilter): LevelCounts {
  const counts: LevelCounts = { debug: 0, info: 0, warn: 0, error: 0 };
  const scope: LogFilter = { ...filter, minLevel: null };
  const { matcher } = compileQuery(filter.query);
  for (const line of lines) {
    if (!matchesScope(line, scope)) continue;
    if (filter.mode === 'hide' && matcher !== null && !matcher(line.text)) continue;
    // An inherited level (a stack frame) is shown at that level but not tallied again.
    if (!line.levelKnown && line.level !== 'info') continue;
    counts[line.level] += 1;
  }
  return counts;
}

/**
 * Step through `[null, ...options]` - null being "all" - in either direction,
 * wrapping. A current value that has since vanished (a server that stopped
 * logging) restarts the cycle from "all".
 */
export function cycleOption(options: readonly string[], current: string | null, direction: 1 | -1): string | null {
  const ring: Array<string | null> = [null, ...options];
  const index = ring.indexOf(current);
  const from = index === -1 ? 0 : index;
  return ring[(from + direction + ring.length) % ring.length];
}

const LEVEL_CYCLE: Array<LogLevel | null> = [null, 'warn', 'error'];

/** all -> warn+ -> error only -> all. Debug-only is not a useful place to rest. */
export function cycleMinLevel(current: LogLevel | null): LogLevel | null {
  const index = LEVEL_CYCLE.indexOf(current);
  return LEVEL_CYCLE[(index + 1) % LEVEL_CYCLE.length];
}

/** Whether any dimension narrows the view, for the "filters active" badge. */
export function isFiltering(filter: LogFilter): boolean {
  return (
    filter.server !== null ||
    filter.app !== null ||
    filter.process !== null ||
    filter.minLevel !== null ||
    filter.query !== ''
  );
}

/** What can be picked in each dimension, derived from the lines actually seen. */
export interface LogFacets {
  servers: string[];
  apps: string[];
  processes: string[];
}

/**
 * Facets narrow each other: once an app is chosen, only its processes are
 * offered. Derived from the buffer, not config, so a process that has never
 * logged does not clutter the cycle.
 */
export function logFacets(lines: readonly LogLine[], filter: Pick<LogFilter, 'server' | 'app'>): LogFacets {
  const servers = new Set<string>();
  const apps = new Set<string>();
  const processes = new Set<string>();
  for (const line of lines) {
    servers.add(line.server);
    if (filter.server === null || line.server === filter.server) apps.add(line.app);
    if (
      (filter.server === null || line.server === filter.server) &&
      (filter.app === null || line.app === filter.app) &&
      line.process !== null
    ) {
      processes.add(line.process);
    }
  }
  const sorted = (set: Set<string>): string[] => [...set].sort();
  return { servers: sorted(servers), apps: sorted(apps), processes: sorted(processes) };
}

/**
 * Whether one line passes. Used where lines are consumed as they arrive
 * (`logs --follow`) rather than filtered out of a buffer.
 */
export function matchesLogFilter(line: LogLine, filter: LogFilter): boolean {
  return applyLogFilter([line], { ...filter, mode: 'hide' }).lines.length > 0;
}

/** Parse a `--level` value; the error names what is accepted. */
export function parseLevelOption(raw: string | undefined): { level: LogLevel | null; error?: string } {
  if (raw === undefined) return { level: null };
  const name = raw.toLowerCase();
  if (name === 'debug' || name === 'info' || name === 'warn' || name === 'error') {
    return { level: name === 'debug' ? null : name };
  }
  return { level: null, error: `Unknown level '${raw}'. Use one of: debug, info, warn, error.` };
}

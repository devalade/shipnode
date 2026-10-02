/**
 * Log lines as values.
 *
 * A streamed line carries where it came from (server, app, process) and what it
 * says, so filtering is a pure function over lines rather than a property of
 * which connection happened to deliver them.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Higher is more severe. Lines with no recognisable level rank as `info`. */
export const LOG_LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogLine {
  /** Monotonic per stream; a stable React key and a tie-break for equal timestamps. */
  id: number;
  /** Receipt time, ms. Remote clocks are not trusted, so this orders lines across servers. */
  at: number;
  server: string;
  app: string;
  /** PM2 process or systemd unit; null when the source cannot say (Caddy access log). */
  process: string | null;
  /**
   * True when the level was read from this line's own text. False for lines
   * that defaulted to info or inherited an error from the line above (a stack
   * frame), so counts do not tally one exception once per frame.
   */
  levelKnown: boolean;
  level: LogLevel;
  text: string;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

// ── Level classification ──────────────────────────────────────────

const RED_TAG = /\[(fatal|error)\]/i;
const YELLOW_TAG = /\[warn(ing)?\]/i;
const RED_PREFIX = /(^|\s)(fatal|error)\s*[:\]]/i;
const CAMEL_ERROR = /[a-z](Error|Exception)\b/;
const RED_WORD = /\b(fatal|exception|uncaught|unhandled|panic|crit(ical)?)\b/i;
const YELLOW_WORD = /\bwarn(ing)?\b/i;
const PLAIN_ERROR = /\berror\b/i;

/** Numeric pino levels: trace10 debug20 info30 warn40 error50 fatal60. */
function jsonLevel(line: string): LogLevel | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;

  // Caddy access log: no useful level (always "info"), but the status says it.
  if (typeof record.status === 'number' && 'request' in record) {
    if (record.status >= 500) return 'error';
    if (record.status >= 400) return 'warn';
    return 'info';
  }

  const level = record.level ?? record.severity;
  if (typeof level === 'number') {
    if (level >= 50) return 'error';
    if (level >= 40) return 'warn';
    if (level >= 30) return 'info';
    return 'debug';
  }
  if (typeof level === 'string') {
    const name = level.toLowerCase();
    if (['error', 'fatal', 'panic', 'crit', 'critical'].includes(name)) return 'error';
    if (['warn', 'warning'].includes(name)) return 'warn';
    if (['info', 'notice'].includes(name)) return 'info';
    if (['debug', 'trace', 'verbose'].includes(name)) return 'debug';
  }
  return undefined;
}

/**
 * The level a raw line announces, or undefined when it announces none.
 *
 * Structured JSON logs (pino/winston `level`/`severity`) win first; plain text
 * falls back to bracket tags, "ERROR:"-style prefixes, camelCase Error class
 * names, then whole-word matches - never a bare substring, so "mirror" or
 * "Terror" do not false-positive.
 */
export function detectLevel(line: string): LogLevel | undefined {
  const structured = jsonLevel(line);
  if (structured !== undefined) return structured;

  if (
    RED_TAG.test(line) ||
    RED_PREFIX.test(line) ||
    CAMEL_ERROR.test(line) ||
    RED_WORD.test(line) ||
    PLAIN_ERROR.test(line)
  ) {
    return 'error';
  }
  if (YELLOW_TAG.test(line) || YELLOW_WORD.test(line)) return 'warn';
  return undefined;
}

/** A stack-trace frame belongs to the error line above it, not to a level of its own. */
export function isContinuation(text: string): boolean {
  return /^\s+at\s/.test(text) || /^\s*\.\.\.\s*\d+ more/.test(text);
}

// ── Per-supervisor line parsing ───────────────────────────────────

export interface ParsedLine {
  process: string | null;
  text: string;
}

/**
 * `pm2 logs` prefixes each line with `<id>|<name>  | `, and prints a
 * `<path> last N lines:` banner per log file ahead of the backlog. Banners are
 * noise; unprefixed lines (pm2's own notices) keep a null process.
 */
export function parsePm2Line(raw: string): ParsedLine | null {
  const line = stripAnsi(raw);
  if (/^\S+\.log last \d+ lines:\s*$/.test(line)) return null;
  const match = /^(\d+)\|([^|\s]+)\s*\|\s?(.*)$/.exec(line);
  if (match === null) return { process: null, text: line };
  return { process: match[2], text: match[3] };
}

/** One systemd unit or Caddy file per stream, so the source already knows the process. */
export function parsePlainLine(process: string | null): (raw: string) => ParsedLine | null {
  return (raw) => ({ process, text: stripAnsi(raw) });
}

// ── Chunks to lines ───────────────────────────────────────────────

/**
 * Re-cut arbitrary stream chunks into whole lines.
 *
 * SSH delivers data in whatever sizes the network picked, so a chunk can end
 * mid-line. The unfinished tail is held until its newline arrives. CR is
 * dropped because a pty turns every LF into CRLF.
 */
export class LineAssembler {
  private tail = '';

  push(chunk: string): string[] {
    const parts = (this.tail + chunk).split('\n');
    this.tail = parts.pop() ?? '';
    return parts.map((part) => part.replace(/\r$/, '')).filter((part) => part.length > 0);
  }

  /** The partial line left when the stream ended without a final newline. */
  flush(): string[] {
    const rest = this.tail.replace(/\r$/, '');
    this.tail = '';
    return rest.length > 0 ? [rest] : [];
  }
}

// ── Reconnect de-duplication ──────────────────────────────────────

/**
 * Drops the backlog a reconnect replays.
 *
 * Every (re)connect asks the server for its last N lines so a fresh viewer has
 * context. After a dropped connection those lines were already shown. The
 * backlog is a run of what this source delivered, ending at or after the last
 * line seen - so the guard follows every position in the seen tail where the
 * replay could have started, advancing each on a matching line. Logs repeat
 * themselves (`GET /health 200`), which is why one guess at the start is not
 * enough. The longest consistent replay wins: a line is swallowed while any
 * alignment can still take it, and replay ends at the first line none can -
 * that line, and everything after it, is new.
 */
export class ReplayGuard {
  private seen: string[] = [];
  private replay: string[] = [];
  /** Positions in `replay` each surviving alignment expects next; null until the first replayed line. */
  private alignments: number[] | null = null;
  private replaying = false;

  constructor(private readonly window: number = 50) {}

  /** Arm for a reconnect: the next lines may repeat what was already delivered. */
  arm(): void {
    this.replay = [...this.seen];
    this.alignments = null;
    this.replaying = this.replay.length > 0;
  }

  /** True when the line should be shown. */
  accept(text: string): boolean {
    if (this.replaying) {
      const from = this.alignments ?? this.replay.map((_, index) => index);
      // An alignment that already reached the newest seen line has nothing left to match.
      const next = from
        .filter((at) => at < this.replay.length && this.replay[at] === text)
        .map((at) => at + 1);
      if (next.length > 0) {
        this.alignments = next;
        return false;
      }
      this.endReplay();
    }
    this.seen.push(text);
    if (this.seen.length > this.window) this.seen.shift();
    return true;
  }

  private endReplay(): void {
    this.replaying = false;
    this.alignments = null;
    this.replay = [];
  }
}

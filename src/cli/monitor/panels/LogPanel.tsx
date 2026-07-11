import { Box, Text } from 'ink';

const BG = '#0d1117';

const RED_TAG = /\[(fatal|error)\]/i;
const YELLOW_TAG = /\[warn(ing)?\]/i;
const RED_PREFIX = /(^|\s)(fatal|error)\s*[:\]]/i;
const CAMEL_ERROR = /[a-z](Error|Exception)\b/;
const RED_WORD = /\b(fatal|exception|uncaught|unhandled|panic|crit(ical)?)\b/i;
const YELLOW_WORD = /\bwarn(ing)?\b/i;
const PLAIN_ERROR = /\berror\b/i;

/** Numeric pino levels: trace10 debug20 info30 warn40 error50 fatal60. */
function jsonLogSeverity(line: string): 'red' | 'yellow' | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const level = (parsed as Record<string, unknown>).level ?? (parsed as Record<string, unknown>).severity;

  if (typeof level === 'number') {
    if (level >= 50) return 'red';
    if (level >= 40) return 'yellow';
    return undefined;
  }
  if (typeof level === 'string') {
    const lvl = level.toLowerCase();
    if (['error', 'fatal', 'panic', 'crit', 'critical'].includes(lvl)) return 'red';
    if (['warn', 'warning'].includes(lvl)) return 'yellow';
  }
  return undefined;
}

/**
 * Severity color for a raw log line. Structured JSON logs (pino/winston-style
 * `level`/`severity` fields) win first; plain text falls back to bracket
 * tags, "ERROR:"-style prefixes, camelCase Error/Exception class names, and
 * finally whole-word matches — never a bare substring, so "mirror" or
 * "Terror" don't false-positive.
 */
export function logLineColor(line: string): 'red' | 'yellow' | undefined {
  const structured = jsonLogSeverity(line);
  if (structured !== undefined) return structured;

  if (RED_TAG.test(line) || RED_PREFIX.test(line) || CAMEL_ERROR.test(line) || RED_WORD.test(line) || PLAIN_ERROR.test(line)) {
    return 'red';
  }
  if (YELLOW_TAG.test(line) || YELLOW_WORD.test(line)) return 'yellow';
  return undefined;
}

interface LogPanelProps {
  logBuffer: string;
  maxLines?: number;
  title?: string;
  /** Case-insensitive substring: matching lines pop, the rest fade. */
  search?: string;
  /** True while the user is still typing the search query. */
  searchTyping?: boolean;
  paused?: boolean;
}

export function LogPanel({
  logBuffer,
  maxLines = 30,
  title = 'Live Logs',
  search = '',
  searchTyping = false,
  paused = false,
}: LogPanelProps) {
  const lines = logBuffer ? logBuffer.split('\n').slice(-maxLines) : [];
  const query = search.toLowerCase();
  return (
    <Box borderStyle="round" borderColor="#30363d" padding={1} flexDirection="column" flexGrow={1} backgroundColor={BG}>
      <Box>
        <Text bold color="#d6a85d">{title}</Text>
        {paused && <Text bold color="yellow">  ⏸ paused (space resumes)</Text>}
        {(search !== '' || searchTyping) && (
          <Text color="cyan">  /{search}{searchTyping ? '▌' : ''}</Text>
        )}
      </Box>
      {lines.length === 0 ? (
        <Text dimColor>  Waiting for logs...</Text>
      ) : (
        lines.map((line, i) => {
          if (query !== '') {
            return line.toLowerCase().includes(query) ? (
              <Text key={i} bold color="cyan">{line}</Text>
            ) : (
              <Text key={i} dimColor color="gray">{line}</Text>
            );
          }
          const severity = logLineColor(line);
          return severity !== undefined ? (
            <Text key={i} color={severity}>{line}</Text>
          ) : (
            <Text key={i} dimColor>{line}</Text>
          );
        })
      )}
    </Box>
  );
}

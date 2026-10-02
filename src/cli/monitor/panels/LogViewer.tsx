import { Box, Text } from 'ink';
import type { LevelCounts, LogFilter } from '../../../domain/observe/log-filter.js';
import type { LogLine } from '../../../domain/observe/log-line.js';
import type { SourceHealth } from '../../../services/observe/log-stream.js';
import { levelColor } from '../log-color.js';

const BG = '#0d1117';
const BORDER = '#30363d';
const ACCENT = '#d6a85d';
const MAX_LABEL = 28;

/** Servers keep a colour for the session, kept clear of red/yellow which mean severity. */
const SERVER_COLORS = ['cyan', 'magenta', 'blue', 'greenBright', 'whiteBright'] as const;

export function serverColor(server: string, known: readonly string[]): (typeof SERVER_COLORS)[number] {
  const index = Math.max(0, known.indexOf(server));
  return SERVER_COLORS[index % SERVER_COLORS.length];
}

/** `server app:process`, showing only the parts that actually vary in what is on screen. */
export function sourceLabel(line: LogLine, showServer: boolean, showApp: boolean): string {
  const head = [showServer ? line.server : null, showApp ? line.app : null].filter((part) => part !== null).join(' ');
  const who = line.process === null || line.process === line.app ? null : line.process;
  const label = who === null ? head : head === '' ? who : `${head}:${who}`;
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label;
}

interface LogViewerProps {
  lines: readonly LogLine[];
  matched: ReadonlySet<number>;
  filter: LogFilter;
  /** Every server seen, in a stable order, for colour assignment. */
  servers: readonly string[];
  showServer: boolean;
  showApp: boolean;
  /** Rows available for log lines. */
  height: number;
  /** Lines scrolled back from the newest (0 follows the tail). */
  offset: number;
  frozen: boolean;
  typing: boolean;
  queryError?: string;
  counts?: LevelCounts;
  /** Sources not currently live, for the status line. */
  troubled: readonly SourceHealth[];
  totalSources: number;
  title: string;
  /** Strip mode: lines only, no filter bar. */
  compact?: boolean;
}

function FilterBar({ filter, typing, queryError, counts, frozen }: Pick<LogViewerProps, 'filter' | 'typing' | 'queryError' | 'counts' | 'frozen'>) {
  const chip = (label: string, value: string | null, active = value !== null) => (
    <Text>
      <Text dimColor>{label} </Text>
      <Text bold={active} color={active ? 'cyan' : undefined} dimColor={!active}>{value ?? 'all'}</Text>
      <Text dimColor>{'  '}</Text>
    </Text>
  );
  const level = filter.minLevel === null ? null : filter.minLevel === 'error' ? 'error' : `${filter.minLevel}+`;
  return (
    <Box flexDirection="column">
      <Box>
        {chip('server', filter.server)}
        {chip('app', filter.app)}
        {chip('proc', filter.process)}
        {chip('level', level)}
        <Text dimColor>mode </Text>
        <Text bold>{filter.mode}</Text>
        {frozen && <Text bold color="yellow">{'  '}⏸ paused</Text>}
      </Box>
      <Box>
        <Text dimColor>search </Text>
        {filter.query === '' && !typing ? (
          <Text dimColor>(/ to search; /regex/ and !not supported)</Text>
        ) : (
          <Text color={queryError === undefined ? 'cyan' : 'red'}>
            {filter.query}{typing ? '▌' : ''}
          </Text>
        )}
        {queryError !== undefined && <Text color="red">{'  '}{queryError}</Text>}
        {counts !== undefined && (
          <Text>
            {'   '}
            <Text color="red" bold={counts.error > 0} dimColor={counts.error === 0}>ERR {counts.error}</Text>
            {'  '}
            <Text color="yellow" bold={counts.warn > 0} dimColor={counts.warn === 0}>WARN {counts.warn}</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}

export function LogViewer(props: LogViewerProps) {
  const { lines, matched, filter, servers, showServer, showApp, height, offset, compact = false } = props;
  const end = lines.length - offset;
  const visible = lines.slice(Math.max(0, end - height), Math.max(0, end));
  const labels = visible.map((line) => sourceLabel(line, showServer, showApp));
  const labelWidth = Math.max(0, ...labels.map((label) => label.length));
  const dimMode = filter.mode === 'dim' && filter.query !== '';

  return (
    <Box borderStyle="round" borderColor={BORDER} paddingX={1} flexDirection="column" flexGrow={1} backgroundColor={BG}>
      <Box>
        <Text bold color={ACCENT}>{props.title}</Text>
        {props.frozen && compact && <Text bold color="yellow">{'  '}⏸</Text>}
        {offset > 0 && <Text dimColor>{'  '}↑ {offset} newer below (G to follow)</Text>}
      </Box>
      {!compact && <FilterBar {...props} />}
      {props.troubled.length > 0 && (
        <Text color="yellow" wrap="truncate-end">
          ⚠ {props.troubled.length}/{props.totalSources} source(s) not live:{' '}
          {props.troubled.slice(0, 2).map((t) => `${t.server}/${t.app} ${t.state}${t.error ? ` (${t.error})` : ''}`).join('; ')}
        </Text>
      )}
      {visible.length === 0 ? (
        <Text dimColor>  {props.totalSources === 0 ? 'Nothing to follow.' : 'Waiting for logs...'}</Text>
      ) : (
        visible.map((line, i) => {
          const hit = matched.has(line.id);
          const faded = dimMode && !hit;
          const color = faded ? 'gray' : dimMode && hit ? 'cyan' : levelColor(line.level);
          return (
            <Text key={line.id} wrap="truncate-end">
              {labelWidth > 0 && (
                <Text color={serverColor(line.server, servers)} dimColor={faded}>
                  {labels[i].padEnd(labelWidth)}{' │ '}
                </Text>
              )}
              <Text color={color} bold={dimMode && hit} dimColor={faded || (color === undefined && !line.levelKnown)}>
                {line.text}
              </Text>
            </Text>
          );
        })
      )}
    </Box>
  );
}

import { Box, Text } from 'ink';
import type { LevelCounts, LogFilter } from '../../../domain/observe/log-filter.js';
import type { LogLine } from '../../../domain/observe/log-line.js';
import type { SourceHealth } from '../../../services/observe/log-stream.js';
import { Panel } from '../components/Panel.js';
import { levelColor } from '../log-color.js';
import { color, glyph } from '../theme.js';

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
  // PM2 names a process `<app>-<process>`; the app is already in the label (or implied).
  const short = line.process?.startsWith(`${line.app}-`) ? line.process.slice(line.app.length + 1) : line.process;
  const who = short === null || short === line.app ? null : short;
  const label = who === null ? head : head === '' ? who : `${head}:${who}`;
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label;
}

/** Rows the full viewer spends on anything but lines: edges, filter row, search row. */
export const LOG_VIEWER_CHROME = 4;

interface LogViewerProps {
  lines: readonly LogLine[];
  matched: ReadonlySet<number>;
  filter: LogFilter;
  /** Lines in the buffer before filtering, for "12 of 340". */
  total: number;
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
  health: readonly SourceHealth[];
  /** Strip mode: lines only, filters summarised in the title. */
  compact?: boolean;
  focused?: boolean;
}

function Chip({ label, value }: { label: string; value: string | null }) {
  const active = value !== null;
  return (
    <Text>
      <Text dimColor>{label} </Text>
      <Text bold={active} color={active ? color.info : undefined} dimColor={!active}>{value ?? 'all'}</Text>
      <Text>{'   '}</Text>
    </Text>
  );
}

function levelLabel(filter: LogFilter): string | null {
  if (filter.minLevel === null) return null;
  return filter.minLevel === 'error' ? 'error' : `≥${filter.minLevel}`;
}

function FilterRows({ filter, typing, queryError, counts }: Pick<LogViewerProps, 'filter' | 'typing' | 'queryError' | 'counts'>) {
  return (
    <>
      <Box height={1} justifyContent="space-between">
        <Text wrap="truncate-end">
          <Chip label="server" value={filter.server} />
          <Chip label="app" value={filter.app} />
          <Chip label="proc" value={filter.process} />
          <Chip label="level" value={levelLabel(filter)} />
        </Text>
        {counts !== undefined && (
          <Text>
            <Text color={color.bad} bold={counts.error > 0} dimColor={counts.error === 0}>{counts.error} err</Text>
            <Text dimColor>  </Text>
            <Text color={color.warn} bold={counts.warn > 0} dimColor={counts.warn === 0}>{counts.warn} warn</Text>
          </Text>
        )}
      </Box>
      <Box height={1}>
        <Text wrap="truncate-end">
          <Text color={typing ? color.accent : undefined} dimColor={!typing} bold>/ </Text>
          {filter.query === '' && !typing ? (
            <Text dimColor>search: text, /regex/, !exclude</Text>
          ) : (
            <Text color={queryError === undefined ? undefined : color.bad} bold>
              {filter.query}
              {typing && <Text color={color.accent}>▌</Text>}
            </Text>
          )}
          {queryError !== undefined && <Text color={color.bad}>  {queryError}</Text>}
          {filter.query !== '' && <Text dimColor>   {filter.mode === 'hide' ? 'hiding' : 'dimming'} non-matches (m)</Text>}
        </Text>
      </Box>
    </>
  );
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

function StreamBadge({ health }: { health: readonly SourceHealth[] }) {
  if (health.length === 0) return <Text dimColor>{glyph.unknown} starting</Text>;
  const troubled = health.filter((entry) => entry.state !== 'live');
  if (troubled.length === 0) return <Text color={color.ok}>≋ {health.length} live</Text>;
  const first = troubled[0];
  return (
    <Text color={color.warn}>
      {glyph.alert} {first.server}/{first.app} {first.state}
      {troubled.length > 1 ? ` +${troubled.length - 1}` : ''}
    </Text>
  );
}

export function LogViewer(props: LogViewerProps) {
  const { lines, matched, filter, servers, showServer, showApp, height, offset, compact = false } = props;
  const end = lines.length - offset;
  const visible = lines.slice(Math.max(0, end - height), Math.max(0, end));
  const labels = visible.map((line) => sourceLabel(line, showServer, showApp));
  const labelWidth = Math.max(0, ...labels.map((label) => label.length));
  const dimMode = filter.mode === 'dim' && filter.query !== '';

  const scope = [filter.server, filter.app, filter.process, levelLabel(filter), filter.query === '' ? null : `/${filter.query}`]
    .filter((part) => part !== null)
    .join(` ${glyph.sep} `);
  const subtitle = compact
    ? (scope === '' ? 'all' : scope)
    : `${lines.length === props.total ? lines.length : `${lines.length} of ${props.total}`} lines`;

  const state = props.frozen
    ? <Text color={color.warn} bold>{glyph.pause} paused{offset > 0 ? ` ${glyph.sep} ↑${offset}` : ''}</Text>
    : <StreamBadge health={props.health} />;

  return (
    <Panel title="Logs" subtitle={subtitle} right={state} focused={props.focused}>
      {!compact && <FilterRows {...props} />}
      {visible.length === 0 ? (
        <Text dimColor>
          {props.health.length === 0 ? 'Opening log streams…' : props.total === 0 ? 'Waiting for the first line…' : 'Nothing matches these filters. c clears them.'}
        </Text>
      ) : (
        visible.map((line, i) => {
          const hit = matched.has(line.id);
          const faded = dimMode && !hit;
          const tone = faded ? undefined : levelColor(line.level);
          return (
            <Box key={line.id} height={1}>
              <Text wrap="truncate-end">
                <Text dimColor>{clock(line.at)} </Text>
                {labelWidth > 0 && (
                  <Text color={serverColor(line.server, servers)} dimColor={faded}>{labels[i].padEnd(labelWidth)} </Text>
                )}
                <Text color={tone === undefined ? color.border : tone}>│ </Text>
                <Text
                  color={dimMode && hit ? color.info : tone}
                  bold={dimMode && hit}
                  dimColor={faded || (tone === undefined && !line.levelKnown && !(dimMode && hit))}
                >
                  {line.text}
                </Text>
              </Text>
            </Box>
          );
        })
      )}
    </Panel>
  );
}

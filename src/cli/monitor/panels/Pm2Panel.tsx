import { Box, Text } from 'ink';
import type { HealthInfo, ProcessInfo } from '../state.js';
import { formatBytes, formatUptime } from '../charts.js';
import { Sparkline } from '../components/charts.js';
import { Panel, PANEL_INSET } from '../components/Panel.js';
import { fitColumns, TableHeader, TableRow, type Column } from '../components/Table.js';
import { color, glyph, processTone, toneColor } from '../theme.js';

const LEAD = 4;

const COLUMNS: Column[] = [
  { key: 'name', header: 'PROCESS', width: 16 },
  { key: 'status', header: 'STATUS', width: 10 },
  { key: 'cpu', header: 'CPU', width: 7, align: 'right' },
  { key: 'mem', header: 'MEM', width: 10, align: 'right', drop: 1 },
  { key: 'up', header: 'UPTIME', width: 11, align: 'right', drop: 2 },
  { key: 'restarts', header: '↻', width: 5, align: 'right', drop: 3 },
];

interface Pm2PanelProps {
  /** Outer width, for choosing which columns fit. */
  width: number;
  processes: ProcessInfo[];
  cpuHistory: number[];
  memHistory: number[];
  health?: HealthInfo;
  responseHistory: number[];
  selectedIndex?: number;
  focused?: boolean;
}

function mode(p: ProcessInfo): string {
  if (p.execMode === 'cluster') return `cluster ×${p.instances}`;
  if (p.execMode === 'threads') return `threads ×${p.instances}`;
  if (p.execMode === 'fork') return 'fork';
  return p.supervisor === 'systemd' ? 'systemd' : '';
}

function uptimeOf(p: ProcessInfo): string {
  if (p.status !== 'online' || p.uptime <= 0) return '—';
  return formatUptime(Math.floor((Date.now() - p.uptime) / 1000));
}

/** The facts that do not fit a table row, for the selected process only. */
function Details({ process }: { process: ProcessInfo }) {
  const parts = [
    `pid ${process.pid ?? '—'}`,
    mode(process),
    process.nodeVersion !== undefined ? `node ${process.nodeVersion}` : '',
    process.pm2Name !== process.name ? process.pm2Name : '',
  ].filter((part) => part !== '');
  return (
    <Box height={1}>
      <Text wrap="truncate-end">
        <Text dimColor>{parts.join(`  ${glyph.sep}  `)}</Text>
        {process.unstableRestarts > 0 && <Text color={color.warn}>  {glyph.sep}  {process.unstableRestarts} unstable restarts</Text>}
        {process.status !== 'online' && process.exitCode !== null && <Text color={color.bad}>  {glyph.sep}  exit {process.exitCode}</Text>}
      </Text>
    </Box>
  );
}

export function Pm2Panel({ width, processes, cpuHistory, memHistory, health, responseHistory, selectedIndex, focused = false }: Pm2PanelProps) {
  const online = processes.filter((p) => p.status === 'online').length;
  const healthBadge =
    health === undefined ? undefined : (
      <Text>
        <Text color={health.status === 'ok' ? color.ok : color.bad}>
          {health.status === 'ok' ? glyph.ok : glyph.down} {health.httpCode || 'down'}
        </Text>
        <Text dimColor> {health.responseMs}ms </Text>
        {responseHistory.length > 1 && <Sparkline values={responseHistory} width={10} />}
      </Text>
    );

  const selected = selectedIndex === undefined ? undefined : processes[selectedIndex];
  const columns = fitColumns(COLUMNS, width - PANEL_INSET, LEAD);
  return (
    <Panel
      title="Processes"
      subtitle={processes.length > 0 ? `${online}/${processes.length} online` : undefined}
      right={healthBadge}
      focused={focused}
    >
      {processes.length === 0 ? (
        <Text dimColor>No processes reported for this app.</Text>
      ) : (
        <>
          <TableHeader columns={columns} lead={LEAD} />
          {processes.map((p, index) => {
            const isSelected = index === selectedIndex;
            const tone = processTone(p.status);
            return (
              <TableRow
                key={p.pm2Name}
                columns={columns}
                lead={
                  <Box width={LEAD} flexShrink={0}>
                    <Text color={color.accent}>{isSelected ? glyph.select : ' '} </Text>
                    <Text color={toneColor(tone)} dimColor={tone === 'muted'}>{tone === 'ok' ? glyph.ok : glyph.down}</Text>
                  </Box>
                }
                cells={{
                  name: <Text bold={isSelected} color={isSelected ? color.accent : undefined}>{p.name}</Text>,
                  status: <Text color={toneColor(tone)} dimColor={tone === 'muted'}>{p.status}</Text>,
                  cpu: `${p.cpu.toFixed(0)}%`,
                  mem: formatBytes(p.memory),
                  up: <Text dimColor>{uptimeOf(p)}</Text>,
                  restarts: <Text color={p.restarts > 0 ? color.warn : undefined} dimColor={p.restarts === 0}>{p.restarts}</Text>,
                }}
              />
            );
          })}
          <Box flexGrow={1} />
          {selected !== undefined && <Details process={selected} />}
          {cpuHistory.length > 1 && (
            <Box height={1}>
              <Text wrap="truncate-end">
                <Text dimColor>cpu </Text><Sparkline values={cpuHistory} width={16} />
                <Text dimColor>{'   '}mem </Text><Sparkline values={memHistory} width={16} />
                <Text dimColor>{'   '}last {cpuHistory.length} polls</Text>
              </Text>
            </Box>
          )}
        </>
      )}
    </Panel>
  );
}

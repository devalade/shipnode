import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { FleetView, ServerSnapshot } from '../../../domain/observe/snapshot.js';
import { systemCpuPercent } from '../../../domain/observe/types.js';
import { describeFleet, type FleetRow } from '../fleet-model.js';
import { formatBytes, formatUptime } from '../charts.js';
import { Meter } from '../components/charts.js';
import { Panel, PANEL_INSET } from '../components/Panel.js';
import { Cell, fitColumns, TableHeader, TableRow, type Column } from '../components/Table.js';
import { color, glyph, toneColor } from '../theme.js';

/** Selection marker and status dot: `❯ ● `. */
const LEAD = 4;

const APP_COLUMNS: Column[] = [
  { key: 'server', header: 'SERVER', width: 16 },
  { key: 'release', header: 'RELEASE', width: 24 },
  { key: 'procs', header: 'PROCS', width: 8, align: 'right' },
  { key: 'cpu', header: 'CPU', width: 7, align: 'right', drop: 2 },
  { key: 'mem', header: 'MEM', width: 10, align: 'right', drop: 3 },
  { key: 'health', header: 'HEALTH', width: 16 },
  { key: 'restarts', header: '↻', width: 5, align: 'right', drop: 4 },
];

type Item = { kind: 'app'; fleet: FleetView } | { kind: 'row'; row: FleetRow };

function ReleaseCell({ row }: { row: FleetRow }) {
  if (row.release === null) return <Text color={color.warn}>no release</Text>;
  return (
    <Text>
      <Text color={row.releaseState === 'behind' ? color.bad : undefined}>{row.release}</Text>
      {row.releaseState === 'behind' && <Text color={color.bad} bold> behind</Text>}
    </Text>
  );
}

function rowCells(row: FleetRow, selected: boolean): Record<string, ReactNode> {
  const server = <Text bold={selected} color={selected ? color.accent : undefined}>{row.server}</Text>;
  const backend = row.appType === 'backend';
  return {
    server,
    release: <ReleaseCell row={row} />,
    procs: backend ? (
      <Text color={row.total > 0 && row.online === row.total ? undefined : color.bad}>{row.online}/{row.total}</Text>
    ) : (
      <Text dimColor>static</Text>
    ),
    cpu: backend ? `${row.cpu.toFixed(0)}%` : <Text dimColor>—</Text>,
    mem: backend ? formatBytes(row.memoryMb) : <Text dimColor>—</Text>,
    health:
      row.health === undefined ? (
        <Text dimColor>—</Text>
      ) : (
        <Text color={row.health.status === 'ok' ? color.ok : color.bad}>
          {row.health.httpCode || 'down'} <Text dimColor>{glyph.sep} {row.health.responseMs}ms</Text>
        </Text>
      ),
    restarts: <Text color={row.restarts > 0 ? color.warn : undefined} dimColor={row.restarts === 0}>{row.restarts}</Text>,
  };
}

function ReplicaRow({ row, selected, columns }: { row: FleetRow; selected: boolean; columns: readonly Column[] }) {
  const degraded = row.error !== undefined || (row.total > 0 && row.online < row.total);
  const dot = !row.reachable ? glyph.down : degraded ? glyph.degraded : glyph.ok;
  const dotColor = !row.reachable || row.error !== undefined ? color.bad : degraded ? color.warn : color.ok;
  const lead = (
    <Box width={LEAD} flexShrink={0}>
      <Text color={color.accent}>{selected ? glyph.select : ' '} </Text>
      <Text color={dotColor}>{dot}</Text>
    </Box>
  );
  const problem = !row.reachable ? `unreachable${row.error !== undefined ? ` ${glyph.sep} ${row.error}` : ''}` : row.error;
  if (problem !== undefined) {
    return (
      <Box height={1}>
        {lead}
        <Cell width={columns[0].width}>{rowCells(row, selected).server}</Cell>
        <Text color={color.bad} wrap="truncate-end">{problem}</Text>
      </Box>
    );
  }
  return <TableRow columns={columns} cells={rowCells(row, selected)} lead={lead} />;
}

function AppHeading({ fleet }: { fleet: FleetView }) {
  const verdict = describeFleet(fleet);
  return (
    <Box height={1}>
      <Text wrap="truncate-end">
        <Text bold>{fleet.app}</Text>
        <Text dimColor> {fleet.appType}  </Text>
        <Text color={toneColor(verdict.tone)}>{verdict.tone === 'ok' ? '✓' : glyph.alert} {verdict.text}</Text>
      </Text>
    </Box>
  );
}

interface AppsPanelProps {
  /** Outer width, for choosing which columns fit. */
  width: number;
  fleets: readonly FleetView[];
  rows: readonly FleetRow[];
  selectedKey: string | null;
  /** Body rows available; the list scrolls to keep the selection in view. */
  height: number;
  serverCount: number;
}

/** Every app, and under it every server it runs on. The view's focus. */
export function AppsPanel({ width, fleets, rows, selectedKey, height, serverCount }: AppsPanelProps) {
  const columns = fitColumns(APP_COLUMNS, width - PANEL_INSET, LEAD);
  const items: Item[] = fleets.flatMap((fleet) => [
    { kind: 'app' as const, fleet },
    ...rows.filter((row) => row.app === fleet.app).map((row) => ({ kind: 'row' as const, row })),
  ]);
  const room = Math.max(1, height);
  const at = items.findIndex((item) => item.kind === 'row' && item.row.key === selectedKey);
  const start = at < 0 ? 0 : Math.min(Math.max(0, at - Math.floor(room / 2)), Math.max(0, items.length - room));
  const visible = items.slice(start, start + room);
  const hiddenAbove = start;
  const hiddenBelow = Math.max(0, items.length - start - room);

  return (
    <Panel
      focused
      title="Apps"
      subtitle={`${fleets.length} app${fleets.length === 1 ? '' : 's'} ${glyph.sep} ${rows.length} replica${rows.length === 1 ? '' : 's'}`}
      right={hiddenAbove + hiddenBelow > 0 ? <Text dimColor>{hiddenAbove > 0 ? `↑${hiddenAbove} ` : ''}{hiddenBelow > 0 ? `↓${hiddenBelow}` : ''}</Text> : undefined}
    >
      {fleets.length === 0 ? (
        <Text dimColor>Connecting to {serverCount} server{serverCount === 1 ? '' : 's'}…</Text>
      ) : (
        <>
          <TableHeader columns={columns} lead={LEAD} />
          {visible.map((item) =>
            item.kind === 'app' ? (
              <AppHeading key={`app:${item.fleet.app}`} fleet={item.fleet} />
            ) : (
              <ReplicaRow key={item.row.key} row={item.row} selected={item.row.key === selectedKey} columns={columns} />
            ),
          )}
        </>
      )}
    </Panel>
  );
}

const SERVER_COLUMNS: Column[] = [
  { key: 'server', header: 'SERVER', width: 16 },
  { key: 'cpu', header: 'CPU', width: 16 },
  { key: 'mem', header: 'MEM', width: 16 },
  { key: 'disk', header: 'DISK', width: 16, drop: 2 },
  { key: 'load', header: 'LOAD', width: 13, drop: 3 },
  { key: 'up', header: 'UP', width: 12, drop: 4 },
];

/** Host-level facts, once per server rather than once per app on it. */
export function ServersPanel({ width, servers, expected }: { width: number; servers: readonly ServerSnapshot[]; expected: number }) {
  const columns = fitColumns(SERVER_COLUMNS, width - PANEL_INSET, 2);
  const down = servers.filter((server) => server.error !== undefined).length;
  return (
    <Panel title="Servers" subtitle={`${expected}${down > 0 ? ` ${glyph.sep} ${down} down` : ''}`}>
      <TableHeader columns={columns} lead={2} />
      {servers.length === 0 && <Text dimColor>Waiting for the first poll…</Text>}
      {servers.map((server) => {
        const name = <Text bold>{server.server}</Text>;
        if (server.error !== undefined) {
          return (
            <Box key={server.server} height={1}>
              <Box width={2} flexShrink={0}><Text color={color.bad}>{glyph.down}</Text></Box>
              <Cell width={16}>{name}</Cell>
              <Text color={color.bad} wrap="truncate-end">{server.error}</Text>
            </Box>
          );
        }
        const { system } = server;
        const locked = server.deployLock != null;
        return (
          <TableRow
            key={server.server}
            columns={columns}
            lead={<Box width={2} flexShrink={0}><Text color={locked ? color.warn : color.ok}>{locked ? glyph.degraded : glyph.ok}</Text></Box>}
            cells={{
              server: name,
              cpu: <Meter percent={systemCpuPercent(system)} width={8} />,
              mem: <Meter percent={system.totalMem > 0 ? system.usedMem / system.totalMem : 0} width={8} />,
              disk: <Meter percent={system.totalDisk > 0 ? system.usedDisk / system.totalDisk : 0} width={8} />,
              load: <Text>{system.load1.toFixed(2)}<Text dimColor> / {system.cores}c</Text></Text>,
              // A held lock matters more than uptime, so it takes that slot.
              up: locked
                ? <Text color={color.warn} bold>lock {server.deployLock?.ageSeconds}s</Text>
                : <Text dimColor>{formatUptime(system.uptime)}</Text>,
            }}
          />
        );
      })}
    </Panel>
  );
}

/** Rows the servers panel needs: title edge, column header, one per server, bottom edge. */
export function serversPanelHeight(count: number): number {
  return Math.max(1, count) + 3;
}

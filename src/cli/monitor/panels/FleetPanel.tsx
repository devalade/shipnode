import { Box, Text } from 'ink';
import type { FleetView, ServerSnapshot } from '../../../domain/observe/snapshot.js';
import { systemCpuPercent } from '../../../domain/observe/types.js';
import { describeFleet, type FleetRow } from '../fleet-model.js';
import { formatBytes } from '../charts.js';
import { Gauge } from '../components/charts.js';

const BG = '#0d1117';
const BG_SELECTED = '#1f2937';
const ACCENT = '#d6a85d';
const TONE = { ok: 'green', warn: 'yellow', bad: 'red' } as const;

interface FleetPanelProps {
  fleets: readonly FleetView[];
  rows: readonly FleetRow[];
  servers: readonly ServerSnapshot[];
  selectedKey: string | null;
  /** Lines available; the list scrolls to keep the selection in view. */
  height: number;
}

type Item =
  | { kind: 'app'; fleet: FleetView }
  | { kind: 'row'; row: FleetRow }
  | { kind: 'servers-head' }
  | { kind: 'server'; server: ServerSnapshot };

function itemsOf(fleets: readonly FleetView[], rows: readonly FleetRow[], servers: readonly ServerSnapshot[]): Item[] {
  const items: Item[] = [];
  for (const fleet of fleets) {
    items.push({ kind: 'app', fleet });
    for (const row of rows) if (row.app === fleet.app) items.push({ kind: 'row', row });
  }
  items.push({ kind: 'servers-head' });
  for (const server of servers) items.push({ kind: 'server', server });
  return items;
}

function shortRelease(release: string | null): string {
  return release === null ? 'none' : release.length > 19 ? release.slice(0, 19) : release;
}

function ReplicaLine({ row, selected }: { row: FleetRow; selected: boolean }) {
  const releaseColor =
    row.releaseState === 'behind' ? 'red' : row.releaseState === 'none' ? 'yellow' : row.releaseState === 'unknown' ? 'gray' : undefined;
  const allOnline = row.total > 0 && row.online === row.total;
  return (
    <Box paddingLeft={1} backgroundColor={selected ? BG_SELECTED : undefined}>
      <Text wrap="truncate-end">
        <Text color={ACCENT}>{selected ? '❯' : ' '}</Text>
        <Text color={row.reachable ? 'green' : 'red'}> {row.reachable ? '●' : '○'} </Text>
        <Text bold>{row.server.padEnd(12).slice(0, 12)}</Text>
        {!row.reachable ? (
          <Text color="red"> unreachable</Text>
        ) : row.error !== undefined ? (
          <Text color="red"> {row.error}</Text>
        ) : (
          <>
            <Text color={releaseColor}> {shortRelease(row.release).padEnd(19)}</Text>
            {row.releaseState === 'behind' && <Text color="red"> behind</Text>}
            {row.appType === 'backend' && (
              <Text color={allOnline ? 'green' : 'red'}> {row.online}/{row.total} up</Text>
            )}
            {row.appType === 'backend' && (
              <Text dimColor> cpu {row.cpu.toFixed(0)}% mem {formatBytes(row.memoryMb)}</Text>
            )}
            {row.restarts > 0 && <Text color="yellow"> ↻{row.restarts}</Text>}
            {row.health !== undefined && (
              <Text color={row.health.status === 'ok' ? 'green' : 'red'}>
                {' '}hc {row.health.httpCode || 'down'} {row.health.responseMs}ms
              </Text>
            )}
          </>
        )}
      </Text>
    </Box>
  );
}

function ServerLine({ server }: { server: ServerSnapshot }) {
  if (server.error !== undefined) {
    return (
      <Box paddingLeft={3}>
        <Text wrap="truncate-end"><Text color="red">○ </Text><Text bold>{server.server.padEnd(12).slice(0, 12)}</Text><Text color="red"> {server.error}</Text></Text>
      </Box>
    );
  }
  const mem = server.system.totalMem > 0 ? server.system.usedMem / server.system.totalMem : 0;
  const disk = server.system.totalDisk > 0 ? server.system.usedDisk / server.system.totalDisk : 0;
  return (
    <Box paddingLeft={3}>
      <Text wrap="truncate-end">
        <Text color="green">● </Text>
        <Text bold>{server.server.padEnd(12).slice(0, 12)}</Text>
        <Text dimColor> cpu </Text><Gauge percent={systemCpuPercent(server.system)} width={8} />
        <Text dimColor> mem </Text><Gauge percent={mem} width={8} />
        <Text dimColor> disk {(disk * 100).toFixed(0)}%</Text>
        {server.deployLock != null && <Text bold color="red"> DEPLOY LOCK {server.deployLock.ageSeconds}s</Text>}
      </Text>
    </Box>
  );
}

export function FleetPanel({ fleets, rows, servers, selectedKey, height }: FleetPanelProps) {
  const items = itemsOf(fleets, rows, servers);
  const selectedAt = items.findIndex((item) => item.kind === 'row' && item.row.key === selectedKey);

  // Keep the selection in view; with nothing selected, show the top.
  const room = Math.max(3, height);
  const start = selectedAt < 0 ? 0 : Math.min(Math.max(0, selectedAt - Math.floor(room / 2)), Math.max(0, items.length - room));
  const visible = items.slice(start, start + room);

  return (
    <Box borderStyle="round" borderColor="#30363d" paddingX={1} flexDirection="column" flexGrow={1} backgroundColor={BG}>
      <Text bold color={ACCENT}>Fleet</Text>
      {fleets.length === 0 && <Text dimColor>  Waiting for data...</Text>}
      {visible.map((item, index) => {
        if (item.kind === 'app') {
          const headline = describeFleet(item.fleet);
          return (
            <Text key={`app:${item.fleet.app}`} wrap="truncate-end">
              <Text bold>{item.fleet.app}</Text>
              <Text dimColor> ({item.fleet.appType}) </Text>
              <Text color={TONE[headline.tone]}>{headline.tone === 'ok' ? '✓' : '⚠'} {headline.text}</Text>
            </Text>
          );
        }
        if (item.kind === 'row') {
          return <ReplicaLine key={item.row.key} row={item.row} selected={item.row.key === selectedKey} />;
        }
        if (item.kind === 'servers-head') {
          return <Text key={`head:${index}`} bold color={ACCENT}>Servers</Text>;
        }
        return <ServerLine key={`server:${item.server.server}`} server={item.server} />;
      })}
    </Box>
  );
}

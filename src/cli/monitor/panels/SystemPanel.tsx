import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { systemCpuPercent, type SystemInfo } from '../state.js';
import { formatBytes, formatUptime } from '../charts.js';
import { Meter } from '../components/charts.js';
import { Panel } from '../components/Panel.js';
import { glyph } from '../theme.js';

interface SystemPanelProps {
  server: string;
  system: SystemInfo;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box height={1}>
      <Box width={6} flexShrink={0}><Text dimColor bold>{label}</Text></Box>
      <Text wrap="truncate-end">{children}</Text>
    </Box>
  );
}

/** The host under the selected app. Host facts only - the app's own trend lives with its processes. */
export function SystemPanel({ server, system }: SystemPanelProps) {
  const mem = system.totalMem > 0 ? system.usedMem / system.totalMem : 0;
  const disk = system.totalDisk > 0 ? system.usedDisk / system.totalDisk : 0;
  return (
    <Panel title="Host" subtitle={server}>
      <Row label="CPU">
        <Meter percent={systemCpuPercent(system)} />
        <Text dimColor>  load {system.load1.toFixed(2)} {system.load5.toFixed(2)} {system.load15.toFixed(2)}</Text>
      </Row>
      <Row label="MEM">
        <Meter percent={mem} />
        <Text dimColor>  {formatBytes(system.usedMem)} / {formatBytes(system.totalMem)}</Text>
      </Row>
      <Row label="DISK">
        <Meter percent={disk} />
        <Text dimColor>  {formatBytes(system.usedDisk * 1024)} / {formatBytes(system.totalDisk * 1024)}</Text>
      </Row>
      <Row label="UP">
        <Text dimColor>{formatUptime(system.uptime)} {glyph.sep} {system.cores} core{system.cores === 1 ? '' : 's'}</Text>
      </Row>
    </Panel>
  );
}

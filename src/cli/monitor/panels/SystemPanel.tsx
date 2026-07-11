import { Box, Text } from 'ink';
import { systemCpuPercent, type SystemInfo } from '../state.js';
import { formatUptime, formatBytes } from '../charts.js';
import { Gauge, Sparkline } from '../components/charts.js';

const BG = '#0d1117';

interface SystemPanelProps {
  system: SystemInfo;
  cpuHistory: number[];
  memHistory: number[];
}

export function SystemPanel({ system, cpuHistory, memHistory }: SystemPanelProps) {
  const memPct = system.totalMem > 0 ? system.usedMem / system.totalMem : 0;
  const diskPct = system.totalDisk > 0 ? system.usedDisk / system.totalDisk : 0;
  const cpuPct = systemCpuPercent(system);

  return (
    <Box borderStyle="round" borderColor="#30363d" paddingX={1} paddingY={1} flexDirection="column" flexGrow={1} backgroundColor={BG}>
      <Text bold color="#d6a85d">  System</Text>

      {/* CPU */}
      <Box marginTop={1} flexDirection="column">
        <Box paddingLeft={1}>
          <Text bold color="cyan">CPU</Text>
          <Text>{'  '}</Text>
          <Gauge percent={cpuPct} width={16} />
          <Text>{'  '}</Text>
          <Text bold color="#d6a85d">{(cpuPct * 100).toFixed(1)}%</Text>
        </Box>
        <Box paddingLeft={5}>
          {cpuHistory.length > 1 ? (
            <Sparkline values={cpuHistory} width={16} />
          ) : (
            <Text dimColor>—</Text>
          )}
        </Box>
        <Box paddingLeft={5}>
          <Text dimColor>
            load {system.load1.toFixed(2)} {system.load5.toFixed(2)} {system.load15.toFixed(2)} / {system.cores} core{system.cores === 1 ? '' : 's'}
          </Text>
        </Box>
      </Box>

      {/* Memory */}
      <Box marginTop={1} flexDirection="column">
        <Box paddingLeft={1}>
          <Text bold color="yellow">MEM</Text>
          <Text>{'  '}</Text>
          <Gauge percent={memPct} width={16} />
          <Text>{'  '}</Text>
          <Text bold color="yellow">{formatBytes(system.usedMem)}</Text>
          <Text dimColor> / {formatBytes(system.totalMem)}</Text>
        </Box>
        <Box paddingLeft={5}>
          {memHistory.length > 1 ? (
            <Sparkline values={memHistory} width={16} />
          ) : (
            <Text dimColor>—</Text>
          )}
        </Box>
      </Box>

      {/* Disk */}
      <Box marginTop={1}>
        <Box paddingLeft={1}>
          <Text bold color="magenta">DSK</Text>
          <Text>{'  '}</Text>
          <Gauge percent={diskPct} width={16} />
          <Text>{'  '}</Text>
          <Text bold color="magenta">{formatBytes(system.usedDisk * 1024)}</Text>
          <Text dimColor> / {formatBytes(system.totalDisk * 1024)}</Text>
        </Box>
      </Box>

      {/* Uptime */}
      <Box marginTop={1}>
        <Box paddingLeft={1}>
          <Text dimColor>up   </Text>
          <Text dimColor>{formatUptime(system.uptime)}</Text>
        </Box>
      </Box>
    </Box>
  );
}

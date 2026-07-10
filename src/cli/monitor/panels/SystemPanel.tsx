import { Box, Text } from 'ink';
import type { SystemInfo } from '../state.js';
import { formatUptime, formatBytes, sampleArray } from '../charts.js';

const BG = '#0d1117';

interface SystemPanelProps {
  system: SystemInfo;
  cpuHistory: number[];
  memHistory: number[];
}

function Gauge({ percent, width }: { percent: number; width: number }) {
  const clamped = Math.max(0, Math.min(1, percent));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const color = percent < 0.6 ? 'green' : percent < 0.85 ? 'yellow' : 'red';
  return (
    <Text color={color}>
      {'█'.repeat(Math.max(0, filled))}{'░'.repeat(Math.max(0, empty))}
    </Text>
  );
}

function Sparkline({ values, width }: { values: number[]; width: number }) {
  if (values.length === 0 || width <= 0) return null;
  if (values.length === 1) {
    return <Text dimColor>{'▁'.repeat(width)}</Text>;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const sampled = sampleArray(values, width);
  const CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

  return (
    <Text>
      {sampled.map((v, i) => {
        const idx = Math.min(Math.round(((v - min) / range) * 7), 7);
        const color = idx < 2 ? 'green' : idx < 5 ? 'yellow' : 'red';
        return <Text key={i} color={color}>{CHARS[idx]}</Text>;
      })}
    </Text>
  );
}

export function SystemPanel({ system, cpuHistory, memHistory }: SystemPanelProps) {
  const memPct = system.totalMem > 0 ? system.usedMem / system.totalMem : 0;
  const diskPct = system.totalDisk > 0 ? system.usedDisk / system.totalDisk : 0;
  const cpuPct = system.cpuLoad;

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

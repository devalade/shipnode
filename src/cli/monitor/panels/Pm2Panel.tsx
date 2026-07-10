import { Box, Text } from 'ink';
import type { ProcessInfo } from '../state.js';
import { formatUptime, formatBytes, statusDot, sampleArray } from '../charts.js';

const BG = '#0d1117';
const BG_ROW = '#111822';

interface Pm2PanelProps {
  processes: ProcessInfo[];
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

export function Pm2Panel({ processes, cpuHistory, memHistory }: Pm2PanelProps) {
  if (processes.length === 0) {
    return (
      <Box borderStyle="round" borderColor="#30363d" padding={1} flexDirection="column" backgroundColor={BG}>
        <Text bold color="#d6a85d">PM2 Processes</Text>
        <Text dimColor>  No PM2 processes (frontend app)</Text>
      </Box>
    );
  }

  return (
    <Box borderStyle="round" borderColor="#30363d" paddingX={1} paddingY={1} flexDirection="column" flexGrow={1} backgroundColor={BG}>
      <Text bold color="#d6a85d">  PM2 Processes</Text>
      {processes.map((p) => {
        const uptimeSeconds = p.uptime > 0 ? Math.floor((Date.now() - p.uptime) / 1000) : 0;
        return (
          <Box key={p.pm2Name} flexDirection="column" marginTop={1} backgroundColor={BG_ROW}>
            {/* Process name row */}
            <Box paddingLeft={1}>
              <Text>
                {statusDot(p.status)} <Text bold>{p.name}</Text>
              </Text>
              <Text dimColor>  pid:{p.pid ?? '—'}  {p.status}</Text>
              {p.restarts > 0 && <Text color="yellow">  restarts:{p.restarts}</Text>}
            </Box>
            {/* CPU row */}
            <Box paddingLeft={2} marginTop={0}>
              <Text bold color="cyan">CPU</Text>
              <Text>{'  '}</Text>
              <Gauge percent={p.cpu / 100} width={16} />
              <Text>{'  '}</Text>
              <Text bold color="#d6a85d">{p.cpu.toFixed(1)}%</Text>
              {cpuHistory.length > 1 && (
                <Box marginLeft={1}>
                  <Sparkline values={cpuHistory} width={12} />
                </Box>
              )}
            </Box>
            {/* Memory row */}
            <Box paddingLeft={2}>
              <Text bold color="yellow">MEM</Text>
              <Text>{'  '}</Text>
              <Gauge percent={Math.min(p.memory / 2048, 1)} width={16} />
              <Text>{'  '}</Text>
              <Text bold color="yellow">{formatBytes(p.memory)}</Text>
              {memHistory.length > 1 && (
                <Box marginLeft={1}>
                  <Sparkline values={memHistory} width={12} />
                </Box>
              )}
            </Box>
            {/* Uptime row */}
            <Box paddingLeft={2}>
              <Text dimColor>up  </Text>
              <Text dimColor>{formatUptime(uptimeSeconds)}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

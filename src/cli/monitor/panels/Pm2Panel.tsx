import { Box, Text } from 'ink';
import type { HealthInfo, ProcessInfo } from '../state.js';
import { formatUptime, formatBytes, statusColor } from '../charts.js';
import { Gauge, Sparkline } from '../components/charts.js';

const BG = '#0d1117';
const BG_ROW = '#111822';
const BG_SELECTED = '#1f2937';

interface Pm2PanelProps {
  processes: ProcessInfo[];
  cpuHistory: number[];
  memHistory: number[];
  health?: HealthInfo;
  responseHistory: number[];
  selectedIndex?: number;
}

function HealthRow({ health, responseHistory }: { health: HealthInfo; responseHistory: number[] }) {
  const ok = health.status === 'ok';
  return (
    <Box paddingLeft={1} marginTop={1}>
      <Text color={ok ? 'green' : 'red'}>●</Text>
      <Text bold> health </Text>
      <Text color={ok ? 'green' : 'red'}>{health.httpCode || 'down'}</Text>
      <Text dimColor> {health.responseMs}ms</Text>
      {responseHistory.length > 1 && (
        <Box marginLeft={1}>
          <Sparkline values={responseHistory} width={12} />
        </Box>
      )}
    </Box>
  );
}

export function Pm2Panel({ processes, cpuHistory, memHistory, health, responseHistory, selectedIndex }: Pm2PanelProps) {
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
      {health !== undefined && <HealthRow health={health} responseHistory={responseHistory} />}
      {processes.map((p, index) => {
        const uptimeSeconds = p.uptime > 0 ? Math.floor((Date.now() - p.uptime) / 1000) : 0;
        const isSelected = index === selectedIndex;
        return (
          <Box key={p.pm2Name} flexDirection="column" marginTop={1} backgroundColor={isSelected ? BG_SELECTED : BG_ROW}>
            {/* Process name row */}
            <Box paddingLeft={1}>
              <Text>
                <Text color="#d6a85d">{isSelected ? '❯' : ' '}</Text>
                <Text color={statusColor(p.status)}>●</Text> <Text bold>{p.name}</Text>
              </Text>
              <Text dimColor>  pid:{p.pid ?? '—'}  {p.status}</Text>
              {p.execMode !== 'unknown' && (
                <Text dimColor>  {p.execMode === 'cluster' ? `cluster×${p.instances}` : 'fork'}</Text>
              )}
              {p.nodeVersion !== undefined && <Text dimColor>  node v{p.nodeVersion}</Text>}
              {p.restarts > 0 && <Text color="yellow">  restarts:{p.restarts}</Text>}
              {p.unstableRestarts > 0 && <Text color="yellow">  unstable:{p.unstableRestarts}</Text>}
              {p.status !== 'online' && p.exitCode !== null && <Text color="red">  exit:{p.exitCode}</Text>}
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

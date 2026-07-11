import { Box, Text } from 'ink';
import type { MetricsSnapshot } from '../state.js';

const BG_HEADER = '#161b22';

interface StatusBarProps {
  lastUpdate: string;
  snapshot: MetricsSnapshot | null;
  polling: boolean;
  error: string | null;
}

export function StatusBar({ lastUpdate, snapshot, polling, error }: StatusBarProps) {
  const health = snapshot?.health;
  return (
    <Box height={1} backgroundColor={BG_HEADER}>
      <Text dimColor>
        {' '}Status: {polling ? 'polling' : snapshot ? 'ready' : 'waiting'}{'  │  '}
        Last update: {lastUpdate || '-'}{'  │  '}
        {snapshot ? `${snapshot.processes.length} process(es)` : '-'}
      </Text>
      {health !== undefined && (
        <Text color={health.status === 'ok' ? 'green' : 'red'}>
          {'  │  '}hc:{health.httpCode || 'down'} {health.responseMs}ms
        </Text>
      )}
      {error && <Text color="red">{'  │  '}{error}</Text>}
    </Box>
  );
}

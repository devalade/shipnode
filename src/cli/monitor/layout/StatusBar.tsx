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
  return (
    <Box height={1} backgroundColor={BG_HEADER}>
      <Text dimColor>
        {' '}Status: {polling ? 'polling' : snapshot ? 'ready' : 'waiting'}{'  │  '}
        Last update: {lastUpdate || '-'}{'  │  '}
        {snapshot ? `${snapshot.processes.length} process(es)` : '-'}
      </Text>
      {error && <Text color="red">{'  │  '}{error}</Text>}
    </Box>
  );
}

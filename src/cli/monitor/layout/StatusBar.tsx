import { Box, Text } from 'ink';

const BG_HEADER = '#161b22';

interface StatusBarProps {
  lastUpdate: string | null;
  polling: boolean;
  /** "3 servers · 5 apps", or whatever summarises what is on screen. */
  summary: string;
  /** Hotkeys for the current view. */
  hints?: string;
  error?: string | null;
}

export function StatusBar({ lastUpdate, polling, summary, hints, error }: StatusBarProps) {
  const updated = lastUpdate === null ? '-' : new Date(lastUpdate).toLocaleTimeString();
  return (
    <Box height={1} backgroundColor={BG_HEADER}>
      <Text wrap="truncate-end" dimColor>
        {' '}Status: {polling ? 'polling' : lastUpdate === null ? 'waiting' : 'ready'}{'  │  '}
        Last update: {updated}{'  │  '}{summary}
        {hints !== undefined && `  │  ${hints}`}
      </Text>
      {error != null && <Text color="red">{'  │  '}{error}</Text>}
    </Box>
  );
}

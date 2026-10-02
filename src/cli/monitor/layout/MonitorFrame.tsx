import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { HeaderBar, type HeaderAlert } from './HeaderBar.js';
import { StatusBar } from './StatusBar.js';

const BG = '#0d1117';
const BORDER = '#30363d';

interface MonitorFrameProps {
  scope: string;
  interval: number;
  liveMode: boolean;
  alerts: readonly HeaderAlert[];
  lastUpdate: string | null;
  polling: boolean;
  summary: string;
  hints?: string;
  error?: string | null;
  children: ReactNode;
}

export function MonitorFrame({ scope, interval, liveMode, alerts, lastUpdate, polling, summary, hints, error, children }: MonitorFrameProps) {
  return (
    <Box flexDirection="column" height="100%" backgroundColor={BG}>
      <HeaderBar scope={scope} interval={interval} liveMode={liveMode} alerts={alerts} />
      {children}
      <StatusBar lastUpdate={lastUpdate} polling={polling} summary={summary} hints={hints} error={error} />
    </Box>
  );
}

export function WaitingPanel() {
  return (
    <Box borderStyle="round" borderColor={BORDER} padding={1} flexGrow={1} backgroundColor={BG}>
      <Text dimColor>Waiting for data...</Text>
    </Box>
  );
}

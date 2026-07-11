import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { ShipnodeApp } from '../../../shared/types.js';
import type { MetricsSnapshot } from '../state.js';
import { HeaderBar } from './HeaderBar.js';
import { StatusBar } from './StatusBar.js';

const BG = '#0d1117';
const BORDER = '#30363d';

interface MonitorFrameProps {
  app: ShipnodeApp;
  targetName: string;
  host: string;
  interval: number;
  liveMode: boolean;
  lastUpdate: string;
  snapshot: MetricsSnapshot | null;
  polling: boolean;
  error: string | null;
  children: ReactNode;
}

export function MonitorFrame({
  app,
  targetName,
  host,
  interval,
  liveMode,
  lastUpdate,
  snapshot,
  polling,
  error,
  children,
}: MonitorFrameProps) {
  return (
    <Box flexDirection="column" height="100%" backgroundColor={BG}>
      <HeaderBar
        app={app}
        targetName={targetName}
        host={host}
        interval={interval}
        liveMode={liveMode}
        deployLock={snapshot?.deployLock}
      />
      {children}
      <StatusBar
        lastUpdate={lastUpdate}
        snapshot={snapshot}
        polling={polling}
        error={error}
      />
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

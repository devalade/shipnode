import { Box, Text } from 'ink';
import type { ShipnodeApp } from '../../../shared/types.js';

const BG = '#0d1117';

interface StaticFrontendPanelProps {
  app: ShipnodeApp;
}

export function StaticFrontendPanel({ app }: StaticFrontendPanelProps) {
  return (
    <Box borderStyle="round" borderColor="#30363d" padding={1} flexDirection="column" flexGrow={1} backgroundColor={BG}>
      <Text bold color="#d6a85d">  Static Frontend</Text>
      <Box marginTop={1} paddingLeft={1} flexDirection="column">
        <Text>app        {app.name}</Text>
        <Text>build dir  {app.buildDir ?? 'dist (auto-detected)'}</Text>
        <Text dimColor>served by Caddy, no PM2 processes expected</Text>
      </Box>
    </Box>
  );
}

import { Box, Text } from 'ink';
import type { ShipnodeApp } from '../../../shared/types.js';

const ACCENT = '#d6a85d';
const BG_HEADER = '#161b22';

interface HeaderBarProps {
  app: ShipnodeApp;
  targetName: string;
  host: string;
  interval: number;
  liveMode: boolean;
}

export function HeaderBar({ app, targetName, host, interval, liveMode }: HeaderBarProps) {
  return (
    <Box height={1} backgroundColor={BG_HEADER} paddingLeft={1}>
      <Text bold color={ACCENT}>ShipNode Monitor </Text>
      <Text>— {app.name} ({app.appType}) </Text>
      <Text dimColor>— {targetName} {host}</Text>
      <Text dimColor>{'  │'} interval: {interval}s</Text>
      {liveMode ? (
        <Text>{'  │'} logs: <Text color="green">ON</Text></Text>
      ) : (
        <Text dimColor>  │ logs: off</Text>
      )}
      <Text dimColor>{'  │'} [Q]uit [Tab]switch app [L]logs [R]refresh</Text>
    </Box>
  );
}

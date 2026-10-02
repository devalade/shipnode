import { Box, Text } from 'ink';

const ACCENT = '#d6a85d';
const BG_HEADER = '#161b22';

export interface HeaderAlert {
  text: string;
}

interface HeaderBarProps {
  /** What is being watched: "fleet · 3 servers", or "api on b". */
  scope: string;
  interval: number;
  liveMode: boolean;
  alerts: readonly HeaderAlert[];
}

export function HeaderBar({ scope, interval, liveMode, alerts }: HeaderBarProps) {
  return (
    <Box height={1} backgroundColor={BG_HEADER} paddingLeft={1}>
      <Text wrap="truncate-end">
        <Text bold color={ACCENT}>ShipNode Monitor </Text>
        <Text>— {scope}</Text>
        <Text dimColor>{'  │'} interval: {interval}s</Text>
        {liveMode ? <Text>{'  │'} logs: <Text color="green">ON</Text></Text> : <Text dimColor>  │ logs: off</Text>}
        {alerts.map((alert) => (
          <Text key={alert.text} bold color="red">{'  │ '}{alert.text}</Text>
        ))}
        <Text dimColor>{'  │'} [?] help</Text>
      </Text>
    </Box>
  );
}

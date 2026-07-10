import { Box, Text } from 'ink';

const BG = '#0d1117';

interface LogPanelProps {
  logBuffer: string;
}

export function LogPanel({ logBuffer }: LogPanelProps) {
  const lines = logBuffer ? logBuffer.split('\n').slice(-30) : [];
  return (
    <Box borderStyle="round" borderColor="#30363d" padding={1} flexDirection="column" flexGrow={1} backgroundColor={BG}>
      <Text bold color="#d6a85d">Live Logs</Text>
      {lines.length === 0 ? (
        <Text dimColor>  Waiting for logs...</Text>
      ) : (
        lines.map((line, i) => (
          <Text key={i} dimColor>{line}</Text>
        ))
      )}
    </Box>
  );
}

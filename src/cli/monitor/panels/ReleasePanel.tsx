import { Box, Text } from 'ink';
import type { ReleaseRecord } from '../state.js';

const BG = '#0d1117';

interface ReleasePanelProps {
  currentRelease: string | null;
  releases: ReleaseRecord[];
  maxReleases?: number;
}

export function ReleasePanel({ currentRelease, releases, maxReleases = 5 }: ReleasePanelProps) {
  return (
    <Box borderStyle="round" borderColor="#30363d" paddingX={1} paddingY={1} flexDirection="column" flexGrow={1} backgroundColor={BG}>
      <Text bold color="#d6a85d">  Releases</Text>
      <Box marginTop={1} paddingLeft={1}>
        {currentRelease ? (
          <Text>
            <Text bold>Current: </Text>
            <Text color="#d6a85d">{currentRelease.split('/').pop() ?? currentRelease}</Text>
          </Text>
        ) : (
          <Text dimColor>Current: none</Text>
        )}
      </Box>
      {releases.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {releases.slice(0, maxReleases).map((r, i) => {
            const dur = r.duration ? `${r.duration}s` : '—';
            const statusIcon = r.status === 'success' ? '✓' : '✗';
            const statusColor = r.status === 'success' ? 'green' : 'red';
            const commit = r.gitCommit ? ` ${r.gitCommit.slice(0, 7)}` : '';
            return (
              <Box key={i} paddingLeft={1}>
                <Text>  <Text dimColor>#{i + 1}</Text>  <Text dimColor>{r.timestamp}</Text>  <Text color={statusColor}>{statusIcon}</Text>  <Text dimColor>{dur}{commit}</Text></Text>
              </Box>
            );
          })}
        </Box>
      ) : (
        <Box paddingLeft={1}>
          <Text dimColor>  No releases recorded</Text>
        </Box>
      )}
    </Box>
  );
}

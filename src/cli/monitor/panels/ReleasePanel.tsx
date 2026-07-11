import { Box, Text } from 'ink';
import type { ReleaseRecord } from '../state.js';

const BG = '#0d1117';
const BG_SELECTED = '#1f2937';

interface ReleasePanelProps {
  currentRelease: string | null;
  releases: ReleaseRecord[];
  maxReleases?: number;
  /** Index into the displayed release rows to highlight, or undefined for none. */
  selectedIndex?: number;
}

export function ReleasePanel({ currentRelease, releases, maxReleases = 5, selectedIndex }: ReleasePanelProps) {
  const currentTimestamp = currentRelease?.split('/').pop() ?? null;
  return (
    <Box borderStyle="round" borderColor="#30363d" paddingX={1} paddingY={1} flexDirection="column" flexGrow={1} backgroundColor={BG}>
      <Text bold color="#d6a85d">  Releases</Text>
      <Box marginTop={1} paddingLeft={1}>
        {currentRelease ? (
          <Text>
            <Text bold>Current: </Text>
            <Text color="#d6a85d">{currentTimestamp ?? currentRelease}</Text>
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
            const isSelected = i === selectedIndex;
            const isCurrent = r.timestamp === currentTimestamp;
            return (
              <Box key={i} paddingLeft={1} backgroundColor={isSelected ? BG_SELECTED : undefined}>
                <Text>
                  <Text color="#d6a85d">{isSelected ? '❯' : ' '}</Text>
                  <Text dimColor> #{i + 1}</Text>  <Text dimColor>{r.timestamp}</Text>  <Text color={statusColor}>{statusIcon}</Text>  <Text dimColor>{dur}{commit}</Text>
                  {isCurrent && <Text color="#d6a85d">  ← current</Text>}
                </Text>
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

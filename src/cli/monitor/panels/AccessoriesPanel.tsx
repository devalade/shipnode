import { Box, Text } from 'ink';
import type { AccessoryInfo } from '../state.js';
import { statusColor } from '../charts.js';

const BG = '#0d1117';

interface AccessoriesPanelProps {
  configuredNames: string[];
  accessories: AccessoryInfo[] | undefined;
}

function accessoryDotColor(accessory: AccessoryInfo): string {
  if (accessory.status !== 'running') return statusColor(accessory.status);
  if (accessory.health === 'unhealthy') return 'red';
  if (accessory.health === 'starting') return 'yellow';
  return 'green';
}

export function AccessoriesPanel({ configuredNames, accessories }: AccessoriesPanelProps) {
  const byName = new Map((accessories ?? []).map((a) => [a.name, a]));
  const nameWidth = Math.max(...configuredNames.map((n) => n.length), 4);

  return (
    <Box borderStyle="round" borderColor="#30363d" paddingX={1} flexDirection="column" backgroundColor={BG}>
      <Text bold color="#d6a85d">  Accessories</Text>
      {configuredNames.map((name) => {
        const accessory = byName.get(name);
        if (accessory === undefined) {
          return (
            <Box key={name} paddingLeft={1}>
              <Text color="gray">●</Text>
              <Text> {name.padEnd(nameWidth)} </Text>
              <Text dimColor>{accessories === undefined ? 'waiting…' : 'unavailable'}</Text>
            </Box>
          );
        }
        return (
          <Box key={name} paddingLeft={1}>
            <Text color={accessoryDotColor(accessory)}>●</Text>
            <Text> {name.padEnd(nameWidth)} </Text>
            <Text>{accessory.status}</Text>
            {accessory.health !== '-' && <Text dimColor>  {accessory.health}</Text>}
            <Text dimColor>  {accessory.image}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

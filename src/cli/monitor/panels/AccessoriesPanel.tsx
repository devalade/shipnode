import { Box, Text } from 'ink';
import type { AccessoryInfo } from '../state.js';
import { Panel } from '../components/Panel.js';
import { Cell } from '../components/Table.js';
import { color, glyph } from '../theme.js';

interface AccessoriesPanelProps {
  configuredNames: string[];
  accessories: AccessoryInfo[] | undefined;
}

function accessoryTone(accessory: AccessoryInfo): string {
  if (accessory.status !== 'running') return accessory.status === 'exited' || accessory.status === 'dead' ? color.bad : color.warn;
  if (accessory.health === 'unhealthy') return color.bad;
  if (accessory.health === 'starting') return color.warn;
  return color.ok;
}

export function AccessoriesPanel({ configuredNames, accessories }: AccessoriesPanelProps) {
  const byName = new Map((accessories ?? []).map((a) => [a.name, a]));
  const nameWidth = Math.max(...configuredNames.map((n) => n.length), 6) + 2;

  return (
    <Panel title="Accessories" subtitle={`${configuredNames.length}`}>
      {configuredNames.map((name) => {
        const accessory = byName.get(name);
        return (
          <Box key={name} height={1}>
            <Box width={2} flexShrink={0}>
              <Text color={accessory === undefined ? undefined : accessoryTone(accessory)} dimColor={accessory === undefined}>
                {accessory === undefined ? glyph.unknown : glyph.ok}
              </Text>
            </Box>
            <Cell width={nameWidth}><Text bold>{name}</Text></Cell>
            {accessory === undefined ? (
              <Text dimColor>{accessories === undefined ? 'sampling…' : 'not found'}</Text>
            ) : (
              <Text wrap="truncate-end">
                <Text>{accessory.status}</Text>
                {accessory.health !== '-' && <Text dimColor> {glyph.sep} {accessory.health}</Text>}
                <Text dimColor> {glyph.sep} {accessory.image}</Text>
              </Text>
            )}
          </Box>
        );
      })}
    </Panel>
  );
}

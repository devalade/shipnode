import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { ShipnodeApp } from '../../shared/types.js';

const BG = '#0d1117';
const BG_OVERLAY = '#161b22';
const BG_SELECTED = '#1f2937';

interface AppSelectorProps {
  apps: ShipnodeApp[];
  targetName: string;
  onSelect: (app: ShipnodeApp) => void;
  onCancel: () => void;
}

export function AppSelector({ apps, targetName, onSelect, onCancel }: AppSelectorProps) {
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (key.return) {
      onSelect(apps[selected]);
    } else if (key.escape || input === 'q') {
      onCancel();
    } else if (key.upArrow) {
      setSelected(Math.max(0, selected - 1));
    } else if (key.downArrow) {
      setSelected(Math.min(apps.length - 1, selected + 1));
    }
  });

  return (
    <Box
      flexDirection="column"
      padding={1}
      borderStyle="round"
      borderColor="cyan"
      backgroundColor={BG}
      alignItems="center"
    >
      <Text bold color="#d6a85d">
        Select App ({apps.length} on {targetName})
      </Text>
      {apps.map((app, i) => {
        const typeLabel = app.appType === 'backend' ? 'backend' : 'frontend';
        const isSelected = i === selected;
        return (
          <Box
            key={app.name}
            backgroundColor={isSelected ? BG_SELECTED : BG_OVERLAY}
            paddingX={1}
            width="100%"
          >
            <Text color={isSelected ? '#d6a85d' : undefined}>
              {isSelected ? '❯' : ' '} <Text bold={isSelected}>{app.name}</Text>
            </Text>
            <Text dimColor>  ({typeLabel})</Text>
            {app.domain && <Text dimColor>  {app.domain}</Text>}
          </Box>
        );
      })}
      <Text dimColor>  ↑↓ navigate  Enter select  q/Escape cancel</Text>
    </Box>
  );
}

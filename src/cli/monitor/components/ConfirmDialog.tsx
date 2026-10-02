import { Box, Text, useInput } from 'ink';
import { Panel } from './Panel.js';
import { KeyHints } from './KeyHints.js';
import { color } from '../theme.js';

interface ConfirmDialogProps {
  title: string;
  lines: string[];
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, lines, onConfirm, onCancel }: ConfirmDialogProps) {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y' || key.return) {
      onConfirm();
    } else if (input === 'n' || input === 'N' || key.escape || input === 'q') {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" height="100%" justifyContent="center" alignItems="center">
      <Panel title="Confirm" width={64} focused>
        <Text bold color={color.warn}>{title}</Text>
        {lines.map((line, i) => (
          <Text key={i} dimColor>{line}</Text>
        ))}
        <Box marginTop={1}>
          <KeyHints hints={[['y ⏎', 'confirm'], ['n esc', 'cancel']]} />
        </Box>
      </Panel>
    </Box>
  );
}

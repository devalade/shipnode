import { Box, Text, useInput } from 'ink';

const BG = '#0d1117';
const ACCENT = '#d6a85d';

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
    <Box
      flexDirection="column"
      padding={1}
      borderStyle="round"
      borderColor="yellow"
      backgroundColor={BG}
      alignItems="center"
    >
      <Text bold color={ACCENT}>{title}</Text>
      {lines.map((line, i) => (
        <Text key={i} dimColor>{line}</Text>
      ))}
      <Box marginTop={1}>
        <Text>
          <Text color="green">y/Enter</Text>
          <Text dimColor> confirm  ·  </Text>
          <Text color="red">n/Esc</Text>
          <Text dimColor> cancel</Text>
        </Text>
      </Box>
    </Box>
  );
}

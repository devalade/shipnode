import { Box, Text } from 'ink';

const BG = '#0d1117';
const ACCENT = '#d6a85d';

const BINDINGS: Array<[string, string]> = [
  ['q', 'quit'],
  ['Tab', 'switch app on this server'],
  ['r', 'refresh now'],
  ['l', 'toggle live log strip'],
  ['f', 'fullscreen logs'],
  ['←/→', 'filter logs by process (fullscreen)'],
  ['↑/↓', 'select process'],
  ['Enter/x', 'restart selected process'],
  ['?', 'this help'],
];

export function HelpOverlay() {
  return (
    <Box
      flexDirection="column"
      padding={1}
      borderStyle="round"
      borderColor="cyan"
      backgroundColor={BG}
      alignItems="center"
    >
      <Text bold color={ACCENT}>Keybindings</Text>
      <Box flexDirection="column" marginTop={1}>
        {BINDINGS.map(([keys, description]) => (
          <Box key={keys}>
            <Text bold color={ACCENT}>{keys.padEnd(9)}</Text>
            <Text dimColor>{description}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>press any key to close</Text>
      </Box>
    </Box>
  );
}

import { Box, Text } from 'ink';

const BG = '#0d1117';
const ACCENT = '#d6a85d';

type Section = { title: string; bindings: Array<[string, string]> };

const SECTIONS: Section[] = [
  {
    title: 'Everywhere',
    bindings: [
      ['q', 'quit'],
      ['r', 'refresh now'],
      ['f', 'full-screen logs (scoped to what is selected)'],
      ['l', 'toggle the live log strip'],
      ['?', 'this help'],
    ],
  },
  {
    title: 'Fleet overview',
    bindings: [
      ['↑/↓', 'select an app on a server'],
      ['Enter', 'open that replica'],
    ],
  },
  {
    title: 'Replica detail',
    bindings: [
      ['Esc', 'back to the fleet'],
      ['↑/↓', 'select process or release'],
      ['Enter/x', 'restart process / roll back (single-server apps)'],
    ],
  },
  {
    title: 'Logs',
    bindings: [
      ['s / S', 'filter by server (next / previous)'],
      ['a / A', 'filter by app'],
      ['p / P', 'filter by process'],
      ['v', 'level: all → warn+ → error'],
      ['/', 'search: text, /regex/, !not'],
      ['m', 'search mode: hide others / dim others'],
      ['c', 'clear filters'],
      ['space', 'pause / resume'],
      ['↑/↓ PgUp/PgDn', 'scroll back (pauses)'],
      ['G', 'jump to newest and follow'],
      ['C', 'clear the buffer'],
      ['Esc / f', 'back'],
    ],
  },
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
      {SECTIONS.map((section) => (
        <Box key={section.title} flexDirection="column" marginTop={1}>
          <Text bold>{section.title}</Text>
          {section.bindings.map(([keys, description]) => (
            <Box key={keys}>
              <Text bold color={ACCENT}>{keys.padEnd(15)}</Text>
              <Text dimColor>{description}</Text>
            </Box>
          ))}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>press any key to close</Text>
      </Box>
    </Box>
  );
}

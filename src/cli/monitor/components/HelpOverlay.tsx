import { Box, Text } from 'ink';
import { Panel } from './Panel.js';
import { color } from '../theme.js';

type Section = { title: string; bindings: Array<[string, string]> };

const LEFT: Section[] = [
  {
    title: 'Everywhere',
    bindings: [
      ['f', 'logs, scoped to the selection'],
      ['l', 'log strip under the view'],
      ['r', 'refresh now'],
      ['?', 'this help'],
      ['q', 'quit'],
    ],
  },
  {
    title: 'Fleet',
    bindings: [
      ['↑ ↓', 'select a replica'],
      ['⏎', 'open it'],
    ],
  },
  {
    title: 'Replica',
    bindings: [
      ['↑ ↓', 'select process or release'],
      ['⏎ x', 'restart / roll back'],
      ['esc', 'back to the fleet'],
    ],
  },
];

const RIGHT: Section[] = [
  {
    title: 'Logs',
    bindings: [
      ['s S', 'server: next / previous'],
      ['a A', 'app'],
      ['p P', 'process'],
      ['v', 'level: all, ≥warn, error'],
      ['/', 'search: text, /regex/, !not'],
      ['m', 'hide or dim non-matches'],
      ['c', 'clear filters'],
      ['space', 'pause'],
      ['↑ ↓ pgup pgdn', 'scroll back'],
      ['G', 'follow newest'],
      ['C', 'clear buffer'],
      ['esc f', 'back'],
    ],
  },
];

function Column({ sections }: { sections: Section[] }) {
  return (
    <Box flexDirection="column" width={44} marginRight={2}>
      {sections.map((section) => (
        <Box key={section.title} flexDirection="column" marginBottom={1}>
          <Text bold color={color.accent}>{section.title}</Text>
          {section.bindings.map(([keys, description]) => (
            <Box key={keys} height={1}>
              <Box width={15} flexShrink={0}><Text bold>{keys}</Text></Box>
              <Text dimColor wrap="truncate-end">{description}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

export function HelpOverlay() {
  return (
    <Box flexDirection="column" height="100%" justifyContent="center" alignItems="center">
      <Panel title="Keys" right={<Text dimColor>any key closes</Text>} width={96} focused>
        <Box>
          <Column sections={LEFT} />
          <Column sections={RIGHT} />
        </Box>
      </Panel>
    </Box>
  );
}

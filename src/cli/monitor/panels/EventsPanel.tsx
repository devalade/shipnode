import { Box, Text } from 'ink';
import type { ObserveEvent } from '../../../services/observe/events.js';
import { describeEvent } from '../fleet-model.js';

const ACCENT = '#d6a85d';
const BG = '#0d1117';
const BORDER = '#30363d';
const TONE = { ok: 'green', warn: 'yellow', bad: 'red', info: 'yellow' } as const;

interface EventsPanelProps {
  events: readonly ObserveEvent[];
  rows?: number;
}

export function EventsPanel({ events, rows = 6 }: EventsPanelProps) {
  return (
    <Box borderStyle="round" borderColor={BORDER} paddingX={1} flexDirection="column" flexGrow={1} backgroundColor={BG}>
      <Text bold color={ACCENT}>Events</Text>
      {events.length === 0 ? (
        <Text dimColor>  No events yet. [L] live log strip · [F] fullscreen logs · [?] help</Text>
      ) : (
        events.slice(-rows).map((event, index) => {
          const { tone, text } = describeEvent(event);
          return (
            <Text key={`${index}-${event.at}`} wrap="truncate-end">
              <Text dimColor>{new Date(event.at).toLocaleTimeString()} </Text>
              <Text color={TONE[tone]}>{text}</Text>
            </Text>
          );
        })
      )}
    </Box>
  );
}

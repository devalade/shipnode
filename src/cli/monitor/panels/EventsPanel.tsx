import { Box, Text } from 'ink';
import type { ObserveEvent } from '../../../services/observe/events.js';
import { describeEvent } from '../fleet-model.js';
import { Panel } from '../components/Panel.js';
import { glyph, toneColor } from '../theme.js';

interface EventsPanelProps {
  events: readonly ObserveEvent[];
  rows?: number;
}

const MARK = { ok: '✓', warn: glyph.alert, bad: glyph.alert, info: glyph.sep } as const;

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour12: false });
}

/** What changed and what you did, newest last. */
export function EventsPanel({ events, rows = 5 }: EventsPanelProps) {
  return (
    <Panel title="Activity">
      {events.length === 0 ? (
        <Text dimColor>Quiet so far. Changes in health, reachability and your actions land here.</Text>
      ) : (
        events.slice(-rows).map((event, index) => {
          const { tone, text } = describeEvent(event);
          return (
            <Box key={`${index}-${event.at}`} height={1}>
              <Text wrap="truncate-end">
                <Text dimColor>{clock(event.at)}  </Text>
                <Text color={toneColor(tone)}>{MARK[tone]} {text}</Text>
              </Text>
            </Box>
          );
        })
      )}
    </Panel>
  );
}

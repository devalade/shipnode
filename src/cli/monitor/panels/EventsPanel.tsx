import { Box, Text } from 'ink';

const ACCENT = '#d6a85d';
const BG = '#0d1117';
const BORDER = '#30363d';

interface EventsPanelProps {
  events: string[];
}

export function EventsPanel({ events }: EventsPanelProps) {
  return (
    <Box
      borderStyle="round"
      borderColor={BORDER}
      padding={1}
      flexDirection="column"
      flexGrow={1}
      backgroundColor={BG}
    >
      <Text bold color={ACCENT}>Events</Text>
      {events.length === 0 ? (
        <Text dimColor>  No events yet. [L] live logs · [F] fullscreen · [?] help</Text>
      ) : (
        events.slice(-6).map((event, index) => <Text key={`${index}-${event}`}>{event}</Text>)
      )}
    </Box>
  );
}

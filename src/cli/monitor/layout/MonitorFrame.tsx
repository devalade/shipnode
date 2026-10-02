import { Box, Text } from 'ink';
import { Fragment, type ReactNode } from 'react';
import { KeyHints, type Hint } from '../components/KeyHints.js';
import { color, glyph, toneColor, type Tone } from '../theme.js';
import { useNow } from '../hooks/use-now.js';

export interface HeaderAlert {
  text: string;
}

export interface Flash {
  tone: Tone;
  text: string;
}

interface MonitorFrameProps {
  /** Where the user is: ['fleet'], ['fleet', 'api', 'b'], ['logs', 'api']. */
  crumbs: readonly string[];
  interval: number;
  polling: boolean;
  lastUpdate: string | null;
  /** Live log streaming state, shown only once streaming has started. */
  streaming?: { live: number; total: number } | null;
  alerts: readonly HeaderAlert[];
  hints: readonly Hint[];
  /** A short-lived message from the last action, shown in the footer. */
  flash?: Flash | null;
  children: ReactNode;
}

function ago(iso: string | null, now: number): string {
  if (iso === null) return 'waiting';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return seconds < 2 ? 'just now' : `${seconds}s ago`;
}

function Header({ crumbs, interval, polling, lastUpdate, streaming }: Pick<MonitorFrameProps, 'crumbs' | 'interval' | 'polling' | 'lastUpdate' | 'streaming'>) {
  const now = useNow();
  const stale = lastUpdate !== null && now - Date.parse(lastUpdate) > interval * 3000;
  const pulse = lastUpdate === null || polling ? glyph.unknown : glyph.ok;
  const pulseColor = stale ? color.bad : lastUpdate === null ? undefined : color.ok;
  return (
    <Box height={1} justifyContent="space-between" paddingX={1}>
      <Text wrap="truncate-end">
        <Text bold color={color.accent}>{glyph.brand} shipnode</Text>
        <Text>{'  '}</Text>
        {crumbs.map((crumb, index) => (
          <Fragment key={`${index}-${crumb}`}>
            {index > 0 && <Text dimColor> {glyph.crumb} </Text>}
            <Text bold={index === crumbs.length - 1} dimColor={index < crumbs.length - 1}>{crumb}</Text>
          </Fragment>
        ))}
      </Text>
      <Text>
        {streaming != null && (
          <Text>
            <Text color={streaming.live === streaming.total ? color.ok : color.warn}>≋</Text>
            <Text dimColor> {streaming.live}/{streaming.total} streams  </Text>
          </Text>
        )}
        <Text color={pulseColor} dimColor={pulseColor === undefined}>{pulse}</Text>
        <Text dimColor> {stale ? 'stale' : 'live'} {glyph.sep} every {interval}s {glyph.sep} {ago(lastUpdate, now)}</Text>
      </Text>
    </Box>
  );
}

function AlertBar({ alerts }: { alerts: readonly HeaderAlert[] }) {
  return (
    <Box height={1} paddingX={1}>
      <Text wrap="truncate-end">
        {alerts.map((alert, index) => (
          <Text key={alert.text} color={color.bad} bold>
            {index > 0 ? '   ' : ''}{glyph.alert} {alert.text}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

function Footer({ hints, flash }: { hints: readonly Hint[]; flash?: Flash | null }) {
  return (
    <Box height={1} justifyContent="space-between" paddingX={1}>
      <Box flexShrink={1} overflow="hidden">
        <KeyHints hints={hints} />
      </Box>
      <Box flexShrink={0} marginLeft={2}>
        {flash != null ? (
          <Text color={toneColor(flash.tone)} dimColor={flash.tone === 'muted'} wrap="truncate-end">{flash.text}</Text>
        ) : (
          <KeyHints hints={[['?', 'help'], ['q', 'quit']]} />
        )}
      </Box>
    </Box>
  );
}

/** Header, optional alert bar, the view, and the key-hint footer. */
export function MonitorFrame({ alerts, hints, flash, children, ...header }: MonitorFrameProps) {
  return (
    <Box flexDirection="column" height="100%">
      <Header {...header} />
      {alerts.length > 0 && <AlertBar alerts={alerts} />}
      <Box flexDirection="column" flexGrow={1}>{children}</Box>
      <Footer hints={hints} flash={flash} />
    </Box>
  );
}

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { color } from '../theme.js';

/** Long enough for any terminal; clipped to the panel's width by overflow. */
const RULE = '─'.repeat(512);

interface PanelProps {
  title: string;
  /** Short, dim context after the title: "2 servers", "health 200 · 12ms". */
  subtitle?: ReactNode;
  /** Right-aligned in the top border. */
  right?: ReactNode;
  /** The panel the keys act on gets an accent border. */
  focused?: boolean;
  width?: number | string;
  height?: number;
  flexGrow?: number;
  children?: ReactNode;
}

/** Columns a panel's border and padding take from its width. */
export const PANEL_INSET = 4;

/**
 * A rounded box with its title set into the top border, the way a tiling
 * terminal app labels panes. Ink has no titled border, so the top edge is drawn
 * by hand: a rule clipped by overflow to whatever width the layout grants.
 */
export function Panel({ title, subtitle, right, focused = false, width, height, flexGrow, children }: PanelProps) {
  const edge = focused ? color.accent : color.border;
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      flexGrow={flexGrow ?? (width === undefined ? 1 : 0)}
      flexShrink={width === undefined ? 1 : 0}
      minWidth={0}
    >
      <Box height={1}>
        <Box flexShrink={0}>
          <Text color={edge}>╭─ </Text>
          <Text bold color={color.accent}>{title}</Text>
        </Box>
        {/* When the edge is crowded the subtitle gives way first, then the rule. */}
        {subtitle !== undefined && (
          <Box flexShrink={1} height={1} overflow="hidden">
            <Text dimColor wrap="truncate-end"> {subtitle}</Text>
          </Box>
        )}
        <Text> </Text>
        <Box flexGrow={1} flexShrink={1} flexBasis={0} height={1} overflow="hidden">
          <Text color={edge}>{RULE}</Text>
        </Box>
        {right !== undefined && (
          <Box flexShrink={0}>
            <Text> {right} </Text>
          </Box>
        )}
        <Box flexShrink={0}>
          <Text color={edge}>─╮</Text>
        </Box>
      </Box>
      <Box borderStyle="round" borderTop={false} borderColor={edge} paddingX={1} flexDirection="column" flexGrow={1} overflow="hidden">
        {children}
      </Box>
    </Box>
  );
}

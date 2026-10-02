import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

export interface Column {
  key: string;
  header: string;
  width: number;
  align?: 'left' | 'right';
  /**
   * Narrow terminals drop columns rather than overflow: higher numbers go
   * first. Columns without a priority are the ones the table is for and stay.
   */
  drop?: number;
}

/**
 * The columns that fit in `available` cells after `reserved` (gutters).
 *
 * Ink does not reliably clip text that overruns its box - it bleeds into the
 * neighbouring panel - so a table must never be laid out wider than it is.
 */
export function fitColumns(columns: readonly Column[], available: number, reserved: number = 0): Column[] {
  let kept = [...columns];
  const total = (): number => reserved + kept.reduce((sum, column) => sum + column.width, 0);
  const droppable = columns
    .filter((column) => column.drop !== undefined)
    .sort((a, b) => (b.drop ?? 0) - (a.drop ?? 0));
  for (const column of droppable) {
    if (total() <= available) break;
    kept = kept.filter((candidate) => candidate !== column);
  }
  // Still too wide with only the essentials: the first column (a name) gives up the difference.
  const over = total() - available;
  if (over > 0 && kept.length > 0) {
    kept[0] = { ...kept[0], width: Math.max(MIN_FIRST_COLUMN, kept[0].width - over) };
  }
  return kept;
}

const MIN_FIRST_COLUMN = 8;

/** One fixed-width cell. Content that does not fit is cut, never wrapped, so rows stay one line. */
export function Cell({ width, align = 'left', children }: { width: number; align?: 'left' | 'right'; children: ReactNode }) {
  return (
    <Box width={width} flexShrink={0} justifyContent={align === 'right' ? 'flex-end' : 'flex-start'} paddingRight={align === 'right' ? 2 : 0} overflow="hidden">
      <Text wrap="truncate-end">{children}</Text>
    </Box>
  );
}

/** Dim uppercase column headings aligned to the cells below. `lead` matches the rows' marker gutter. */
export function TableHeader({ columns, lead = 0 }: { columns: readonly Column[]; lead?: number }) {
  return (
    <Box height={1}>
      {lead > 0 && <Box width={lead} flexShrink={0} />}
      {columns.map((column) => (
        <Cell key={column.key} width={column.width} align={column.align}>
          <Text dimColor bold>{column.header}</Text>
        </Cell>
      ))}
    </Box>
  );
}

/** A row laid out by `columns`, taking each cell's content from `cells` by key. */
export function TableRow({ columns, cells, lead }: { columns: readonly Column[]; cells: Record<string, ReactNode>; lead?: ReactNode }) {
  return (
    <Box height={1}>
      {lead}
      {columns.map((column) => (
        <Cell key={column.key} width={column.width} align={column.align}>
          {cells[column.key]}
        </Cell>
      ))}
    </Box>
  );
}

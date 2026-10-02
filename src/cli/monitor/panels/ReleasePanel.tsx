import { Box, Text } from 'ink';
import type { ReleaseRecord } from '../state.js';
import { Panel, PANEL_INSET } from '../components/Panel.js';
import { fitColumns, TableHeader, TableRow, type Column } from '../components/Table.js';
import { color, glyph } from '../theme.js';

const LEAD = 2;

const COLUMNS: Column[] = [
  { key: 'n', header: '#', width: 4, align: 'right' },
  { key: 'release', header: 'RELEASE', width: 22 },
  { key: 'status', header: 'STATUS', width: 11 },
  { key: 'took', header: 'TOOK', width: 7, align: 'right', drop: 2 },
  { key: 'commit', header: 'COMMIT', width: 10, drop: 1 },
  { key: 'tag', header: '', width: 11 },
];

interface ReleasePanelProps {
  /** Outer width, for choosing which columns fit. */
  width: number;
  currentRelease: string | null;
  releases: ReleaseRecord[];
  maxReleases?: number;
  /** Index into the displayed release rows to highlight, or undefined for none. */
  selectedIndex?: number;
  /** Why rollback is unavailable here, shown instead of inviting a keypress. */
  rollbackNote?: string;
}

export function ReleasePanel({ width, currentRelease, releases, maxReleases = 5, selectedIndex, rollbackNote }: ReleasePanelProps) {
  const currentTimestamp = currentRelease?.split('/').pop() ?? null;
  const columns = fitColumns(COLUMNS, width - PANEL_INSET, LEAD);
  return (
    <Panel
      title="Releases"
      subtitle={currentTimestamp === null ? 'none deployed' : `current ${currentTimestamp}`}
      right={rollbackNote !== undefined ? <Text dimColor>{rollbackNote}</Text> : undefined}
    >
      {releases.length === 0 ? (
        <Text dimColor>No releases recorded.</Text>
      ) : (
        <>
          <TableHeader columns={columns} lead={LEAD} />
          {releases.slice(0, maxReleases).map((release, index) => {
            const isSelected = index === selectedIndex;
            const isCurrent = release.timestamp === currentTimestamp;
            const ok = release.status === 'success';
            return (
              <TableRow
                key={release.timestamp}
                columns={columns}
                lead={<Box width={LEAD} flexShrink={0}><Text color={color.accent}>{isSelected ? glyph.select : ' '}</Text></Box>}
                cells={{
                  n: <Text dimColor>{index + 1}</Text>,
                  release: <Text bold={isSelected || isCurrent} color={isSelected ? color.accent : undefined}>{release.timestamp}</Text>,
                  status: <Text color={ok ? color.ok : color.bad}>{ok ? '✓ ok' : '✗ failed'}</Text>,
                  took: <Text dimColor>{release.duration ? `${release.duration}s` : '—'}</Text>,
                  commit: <Text dimColor>{release.gitCommit?.slice(0, 7) ?? '—'}</Text>,
                  tag: isCurrent ? <Text color={color.accent}>{glyph.ok} current</Text> : '',
                }}
              />
            );
          })}
        </>
      )}
    </Panel>
  );
}

/** Rows the panel needs for `count` releases: edges, header, rows. */
export function releasePanelHeight(count: number): number {
  return Math.max(1, count) + 3;
}

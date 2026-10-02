import { Box, Text } from 'ink';
import type { ShipnodeApp } from '../../../shared/types.js';
import type { CaddyInfo } from '../state.js';
import { Panel } from '../components/Panel.js';
import { Cell, TableHeader, type Column } from '../components/Table.js';
import { color, glyph } from '../theme.js';

const COLUMNS: Column[] = [
  { key: 'status', header: 'STATUS', width: 8 },
  { key: 'method', header: 'METHOD', width: 8 },
  { key: 'ms', header: 'TIME', width: 8, align: 'right' },
  { key: 'uri', header: 'PATH', width: 60 },
];

interface StaticFrontendPanelProps {
  app: ShipnodeApp;
  caddy: CaddyInfo | null;
}

function statusTone(status: number): string {
  if (status >= 500) return color.bad;
  if (status >= 400) return color.warn;
  return color.ok;
}

export function StaticFrontendPanel({ app, caddy }: StaticFrontendPanelProps) {
  const badge =
    caddy === null ? (
      <Text dimColor>{glyph.unknown} caddy</Text>
    ) : (
      <Text color={caddy.serviceActive ? color.ok : color.bad}>
        {caddy.serviceActive ? glyph.ok : glyph.down} caddy {caddy.serviceActive ? 'active' : 'inactive'}
      </Text>
    );

  return (
    <Panel title="Site" subtitle={app.buildDir ?? 'dist'} right={badge}>
      {caddy === null && <Text dimColor>Waiting for the first poll…</Text>}
      {caddy !== null && caddy.total === 0 && <Text dimColor>No recent requests in the access log.</Text>}
      {caddy !== null && caddy.total > 0 && (
        <>
          <Box height={1}>
            <Text>
              <Text dimColor>last {caddy.total} requests   </Text>
              <Text color={color.ok}>2xx {caddy.ok2xx}</Text>
              <Text color={caddy.err4xx > 0 ? color.warn : undefined} dimColor={caddy.err4xx === 0}>   4xx {caddy.err4xx}</Text>
              <Text color={caddy.err5xx > 0 ? color.bad : undefined} dimColor={caddy.err5xx === 0}>   5xx {caddy.err5xx}</Text>
            </Text>
          </Box>
          <TableHeader columns={COLUMNS} />
          {caddy.recent.map((request, index) => (
            <Box key={index} height={1}>
              <Cell width={8}><Text color={statusTone(request.status)}>{request.status}</Text></Cell>
              <Cell width={8}><Text dimColor>{request.method}</Text></Cell>
              <Cell width={8} align="right"><Text dimColor>{request.ms}ms</Text></Cell>
              <Text wrap="truncate-end">{request.uri}</Text>
            </Box>
          ))}
        </>
      )}
    </Panel>
  );
}

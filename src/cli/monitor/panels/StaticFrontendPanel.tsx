import { Box, Text } from 'ink';
import type { ShipnodeApp } from '../../../shared/types.js';
import type { CaddyInfo } from '../state.js';

const BG = '#0d1117';

interface StaticFrontendPanelProps {
  app: ShipnodeApp;
  caddy: CaddyInfo | null;
}

export function StaticFrontendPanel({ app, caddy }: StaticFrontendPanelProps) {
  return (
    <Box borderStyle="round" borderColor="#30363d" padding={1} flexDirection="column" flexGrow={1} backgroundColor={BG}>
      <Text bold color="#d6a85d">  Static Frontend</Text>
      <Box marginTop={1} paddingLeft={1} flexDirection="column">
        <Box>
          <Text>app        {app.name}</Text>
        </Box>
        <Box>
          <Text>build dir  {app.buildDir ?? 'dist (auto-detected)'}</Text>
        </Box>
        <Box>
          <Text>caddy      </Text>
          {caddy === null ? (
            <Text dimColor>waiting…</Text>
          ) : (
            <Text color={caddy.serviceActive ? 'green' : 'red'}>
              ● {caddy.serviceActive ? 'active' : 'inactive'}
            </Text>
          )}
        </Box>

        {caddy !== null && caddy.total > 0 && (
          <>
            <Box marginTop={1}>
              <Text dimColor>last {caddy.total} reqs  </Text>
              <Text color="green">2xx {caddy.ok2xx}</Text>
              <Text color={caddy.err4xx > 0 ? 'yellow' : 'gray'}>  4xx {caddy.err4xx}</Text>
              <Text color={caddy.err5xx > 0 ? 'red' : 'gray'}>  5xx {caddy.err5xx}</Text>
            </Box>
            <Box flexDirection="column" marginTop={1}>
              {caddy.recent.map((request, i) => (
                <Box key={i}>
                  <Text color={request.status >= 500 ? 'red' : request.status >= 400 ? 'yellow' : 'green'}>
                    {request.status}
                  </Text>
                  <Text dimColor> {request.method} {request.uri} {request.ms}ms</Text>
                </Box>
              ))}
            </Box>
          </>
        )}
        {caddy !== null && caddy.total === 0 && (
          <Box marginTop={1}>
            <Text dimColor>no recent requests in access log</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

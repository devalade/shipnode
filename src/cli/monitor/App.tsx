import { Box, Text, useInput, useApp } from 'ink';
import { useEffect, useState, useRef } from 'react';
import type { RemoteExecutor } from '../../domain/remote/executor.js';
import type { ShipnodeConfig, ShipnodeApp } from '../../shared/types.js';
import { MetricsHistory, type MetricsSnapshot } from './state.js';
import { collectMetrics, collectLogs } from './poller.js';
import { Pm2Panel } from './panels/Pm2Panel.js';
import { SystemPanel } from './panels/SystemPanel.js';
import { ReleasePanel } from './panels/ReleasePanel.js';
import { LogPanel } from './panels/LogPanel.js';
import { AppSelector } from './app-selector.js';
import chalk from 'chalk';

const ACCENT = '#d6a85d';
const BG = '#0d1117';
const BG_HEADER = '#161b22';
const BORDER = '#30363d';

interface AppProps {
  executor: RemoteExecutor;
  config: ShipnodeConfig;
  app: ShipnodeApp;
  interval: number;
}

export function App({ executor, config, app: initialApp, interval }: AppProps) {
  const { exit } = useApp();
  const [currentApp, setCurrentApp] = useState(initialApp);
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const historyRef = useRef(new MetricsHistory());
  const [liveMode, setLiveMode] = useState(false);
  const [logBuffer, setLogBuffer] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [showSelector, setShowSelector] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string>('');

  const history = historyRef.current;

  const appendEvent = (msg: string) => {
    setEvents((prev) => [...prev.slice(-100), msg]);
  };

  const doPoll = async () => {
    try {
      const snap = await collectMetrics(executor, currentApp, config);
      setSnapshot(snap);
      history.push(snap);
      setLastUpdate(new Date().toLocaleTimeString());
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      appendEvent(chalk.red(`Poll failed: ${msg}`));
    }
  };

  const doLogPoll = async () => {
    try {
      const namespace = currentApp.pm2?.apps[0]?.name ?? '';
      if (!namespace) return;
      const freshLogs = await collectLogs(executor, namespace, 20);
      if (freshLogs && freshLogs !== '(no logs)') {
        setLogBuffer((prev) => {
          const combined = prev
            ? prev.split('\n').slice(-50).join('\n') + '\n' + freshLogs
            : freshLogs;
          return combined;
        });
      }
    } catch {
      // best-effort
    }
  };

  useEffect(() => {
    doPoll();
    const timer = setInterval(doPoll, interval * 1000);
    return () => clearInterval(timer);
  }, [currentApp, interval]);

  useEffect(() => {
    if (!liveMode) return;
    const timer = setInterval(doLogPoll, interval * 1000);
    return () => clearInterval(timer);
  }, [liveMode, currentApp, interval]);

  useInput((input, key) => {
    if (input === 'q') {
      exit();
    }
    if (key.tab) {
      setShowSelector(true);
    }
    if (input === 'l' || input === 'L') {
      setLiveMode((v) => {
        const next = !v;
        if (next) {
          appendEvent(chalk.yellow('Live logs enabled'));
        } else {
          setLogBuffer('');
          appendEvent(chalk.yellow('Live logs disabled'));
        }
        return next;
      });
    }
    if (input === 'r' || input === 'R') {
      doPoll();
      appendEvent(chalk.green('Refresh triggered'));
    }
  });

  if (showSelector) {
    return (
      <AppSelector
        apps={config.apps}
        onSelect={(app) => {
          setCurrentApp(app);
          setShowSelector(false);
          history.clear();
          setLogBuffer('');
          setLiveMode(false);
          setSnapshot(null);
          appendEvent(chalk.green(`Switched to ${chalk.bold(app.name)}`));
        }}
        onCancel={() => setShowSelector(false)}
      />
    );
  }

  const host = currentApp.domain ?? 'no domain';

  return (
    <Box flexDirection="column" height="100%" backgroundColor={BG}>
      {/* Header */}
      <Box height={1} backgroundColor={BG_HEADER} paddingLeft={1} borderBottom={false}>
        <Text bold color={ACCENT}>
          ShipNode Monitor{' '}
        </Text>
        <Text>
          — {currentApp.name} ({currentApp.appType}) —{' '}
        </Text>
        <Text dimColor>{host}</Text>
        <Text dimColor>
          {'  │'} interval: {interval}s
        </Text>
        {liveMode ? (
          <Text>
            {'  │'} logs: <Text color="green">ON</Text>
          </Text>
        ) : (
          <Text dimColor>  │ logs: off</Text>
        )}
        <Text dimColor>
          {'  │'} [Q]uit [Tab]switch app [L]toggle logs [R]refresh
        </Text>
      </Box>

      {/* Main content: PM2 + System */}
      <Box flexGrow={1} flexDirection="row" minHeight={8}>
        <Box width="60%" flexDirection="column">
          {snapshot ? (
            <Pm2Panel
              processes={snapshot.processes}
              cpuHistory={history.cpu}
              memHistory={history.memory}
            />
          ) : (
            <Box borderStyle="round" borderColor={BORDER} padding={1} flexGrow={1} backgroundColor={BG}>
              <Text dimColor>Waiting for data...</Text>
            </Box>
          )}
        </Box>
        <Box width="40%" flexDirection="column">
          {snapshot ? (
            <SystemPanel
              system={snapshot.system}
              cpuHistory={history.cpu}
              memHistory={history.memory}
            />
          ) : (
            <Box borderStyle="round" borderColor={BORDER} padding={1} flexGrow={1} backgroundColor={BG}>
              <Text dimColor>Waiting for data...</Text>
            </Box>
          )}
        </Box>
      </Box>

      {/* Release panel */}
      {snapshot && (
        <Box height={7}>
          <ReleasePanel
            currentRelease={snapshot.currentRelease}
            releases={snapshot.releases}
          />
        </Box>
      )}

      {/* Bottom panel: events or logs */}
      <Box height={8}>
        {liveMode ? (
          <LogPanel logBuffer={logBuffer} />
        ) : (
          <Box
            borderStyle="round"
            borderColor={BORDER}
            padding={1}
            flexDirection="column"
            flexGrow={1}
            backgroundColor={BG}
          >
            <Text bold color={ACCENT}>
              Events
            </Text>
            {events.length === 0 ? (
              <Text dimColor>  No events yet. Press [L] to enable live logs.</Text>
            ) : (
              events.map((e, i) => <Text key={i}>{e}</Text>)
            )}
          </Box>
        )}
      </Box>

      {/* Status bar */}
      <Box height={1} backgroundColor={BG_HEADER}>
        <Text dimColor>
          {' '}Last update: {lastUpdate || '—'}{'  │  '}
          {snapshot ? `${snapshot.processes.length} process(es)` : '—'}
        </Text>
        {error && (
          <Text color="red" dimColor>
            {'  │  '}Error: {error}
          </Text>
        )}
      </Box>
    </Box>
  );
}

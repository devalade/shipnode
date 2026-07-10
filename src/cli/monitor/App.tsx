import { Box, useInput, useApp } from 'ink';
import { useState } from 'react';
import type { RemoteExecutor } from '../../domain/remote/executor.js';
import type { ShipnodeConfig, ShipnodeApp } from '../../shared/types.js';
import { Pm2Panel } from './panels/Pm2Panel.js';
import { SystemPanel } from './panels/SystemPanel.js';
import { ReleasePanel } from './panels/ReleasePanel.js';
import { LogPanel } from './panels/LogPanel.js';
import { EventsPanel } from './panels/EventsPanel.js';
import { StaticFrontendPanel } from './panels/StaticFrontendPanel.js';
import { AppSelector } from './app-selector.js';
import chalk from 'chalk';
import { useMonitorData } from './hooks/use-monitor-data.js';
import { useLiveLogs } from './hooks/use-live-logs.js';
import { MonitorFrame, WaitingPanel } from './layout/MonitorFrame.js';

interface AppProps {
  executor: RemoteExecutor;
  config: ShipnodeConfig;
  app: ShipnodeApp;
  apps: ShipnodeApp[];
  targetName: string;
  host: string;
  interval: number;
}

export function App({ executor, config, app: initialApp, apps, targetName, host, interval }: AppProps) {
  const { exit } = useApp();
  const [currentApp, setCurrentApp] = useState(initialApp);
  const [liveMode, setLiveMode] = useState(false);
  const [showSelector, setShowSelector] = useState(false);
  const monitor = useMonitorData(executor, config, currentApp, interval);
  const liveLogs = useLiveLogs(executor, currentApp, liveMode, interval);

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
          monitor.appendEvent(chalk.yellow('Live logs enabled'));
        } else {
          liveLogs.clearLogs();
          monitor.appendEvent(chalk.yellow('Live logs disabled'));
        }
        return next;
      });
    }
    if (input === 'r' || input === 'R') {
      void monitor.refresh();
      monitor.appendEvent(chalk.green('Refresh triggered'));
    }
  });

  if (showSelector) {
    return (
      <AppSelector
        apps={apps}
        targetName={targetName}
        onSelect={(app) => {
          setCurrentApp(app);
          setShowSelector(false);
          monitor.reset();
          liveLogs.clearLogs();
          setLiveMode(false);
          monitor.appendEvent(chalk.green(`Switched to ${chalk.bold(app.name)}`));
        }}
        onCancel={() => setShowSelector(false)}
      />
    );
  }

  return (
    <MonitorFrame
      app={currentApp}
      targetName={targetName}
      host={host}
      interval={interval}
      liveMode={liveMode}
      lastUpdate={monitor.lastUpdate}
      snapshot={monitor.snapshot}
      polling={monitor.polling}
      error={monitor.error}
    >
      <Box flexGrow={1} flexDirection="row" minHeight={8}>
        <Box width="60%" flexDirection="column">
          {currentApp.appType === 'frontend' ? (
            <StaticFrontendPanel app={currentApp} />
          ) : monitor.snapshot ? (
            <Pm2Panel
              processes={monitor.snapshot.processes}
              cpuHistory={monitor.history.cpu}
              memHistory={monitor.history.memory}
            />
          ) : (
            <WaitingPanel />
          )}
        </Box>
        <Box width="40%" flexDirection="column">
          {monitor.snapshot ? (
            <SystemPanel
              system={monitor.snapshot.system}
              cpuHistory={monitor.history.cpu}
              memHistory={monitor.history.memory}
            />
          ) : (
            <WaitingPanel />
          )}
        </Box>
      </Box>

      {monitor.snapshot && (
        <Box height={7}>
          <ReleasePanel
            currentRelease={monitor.snapshot.currentRelease}
            releases={monitor.snapshot.releases}
          />
        </Box>
      )}

      <Box height={8}>
        {liveMode ? (
          <LogPanel logBuffer={liveLogs.logBuffer} />
        ) : (
          <EventsPanel events={monitor.events} />
        )}
      </Box>
    </MonitorFrame>
  );
}

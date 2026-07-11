import { Box, useInput, useApp, useStdout } from 'ink';
import { useState } from 'react';
import type { RemoteExecutor } from '../../domain/remote/executor.js';
import type { ShipnodeConfig, ShipnodeApp } from '../../shared/types.js';
import { Pm2Panel } from './panels/Pm2Panel.js';
import { SystemPanel } from './panels/SystemPanel.js';
import { ReleasePanel } from './panels/ReleasePanel.js';
import { LogPanel } from './panels/LogPanel.js';
import { EventsPanel } from './panels/EventsPanel.js';
import { StaticFrontendPanel } from './panels/StaticFrontendPanel.js';
import { AccessoriesPanel } from './panels/AccessoriesPanel.js';
import { AppSelector } from './app-selector.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { ConfirmDialog } from './components/ConfirmDialog.js';
import { restartProcess } from './actions.js';
import chalk from 'chalk';
import { useMonitorData } from './hooks/use-monitor-data.js';
import { useLiveLogs } from './hooks/use-live-logs.js';
import { MonitorFrame, WaitingPanel } from './layout/MonitorFrame.js';

type View = 'dashboard' | 'logs';
type Overlay = 'none' | 'selector' | 'help' | 'confirmRestart';

interface AppProps {
  executor: RemoteExecutor;
  config: ShipnodeConfig;
  app: ShipnodeApp;
  apps: ShipnodeApp[];
  accessoryNames: string[];
  targetName: string;
  host: string;
  interval: number;
}

export function App({ executor, config, app: initialApp, apps, accessoryNames, targetName, host, interval }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [currentApp, setCurrentApp] = useState(initialApp);
  const [view, setView] = useState<View>('dashboard');
  const [overlay, setOverlay] = useState<Overlay>('none');
  const [liveMode, setLiveMode] = useState(false);
  const [logFilter, setLogFilter] = useState<string | null>(null);
  const [selectedProcess, setSelectedProcess] = useState(0);
  const monitor = useMonitorData(executor, config, currentApp, interval, accessoryNames);
  const liveActive = liveMode || view === 'logs';
  const liveLogs = useLiveLogs(executor, currentApp, liveActive, interval, logFilter);

  const processes = monitor.snapshot?.processes ?? [];
  const selectedIndex = processes.length === 0 ? 0 : Math.min(selectedProcess, processes.length - 1);
  const selectedInfo = processes[selectedIndex];

  const confirmRestart = async (): Promise<void> => {
    setOverlay('none');
    if (selectedInfo === undefined) return;
    monitor.appendEvent(chalk.yellow(`Restarting ${selectedInfo.pm2Name}…`));
    const result = await restartProcess(executor, selectedInfo.pm2Name);
    if (result.isOk()) {
      monitor.appendEvent(chalk.green(`Restarted ${chalk.bold(selectedInfo.pm2Name)}`));
    } else {
      monitor.appendEvent(chalk.red(result.error.message));
    }
    void monitor.refresh();
  };

  const cycleLogFilter = (direction: 1 | -1): void => {
    if (currentApp.appType === 'frontend') return;
    const names = monitor.snapshot?.processes.map((p) => p.pm2Name) ?? [];
    if (names.length === 0) return;
    const cycle: Array<string | null> = [null, ...names];
    const index = cycle.indexOf(logFilter);
    const next = cycle[(index + direction + cycle.length) % cycle.length];
    setLogFilter(next);
  };

  useInput((input, key) => {
    if (overlay === 'help') {
      setOverlay('none');
      return;
    }
    if (overlay !== 'none') return;

    if (input === 'q') {
      exit();
      return;
    }
    if (input === '?') {
      setOverlay('help');
      return;
    }
    if (input === 'r' || input === 'R') {
      void monitor.refresh();
      monitor.appendEvent(chalk.green('Refresh triggered'));
      return;
    }
    if (input === 'f' || input === 'F') {
      setView((v) => (v === 'logs' ? 'dashboard' : 'logs'));
      return;
    }

    if (view === 'logs') {
      if (key.escape) setView('dashboard');
      if (key.leftArrow) cycleLogFilter(-1);
      if (key.rightArrow) cycleLogFilter(1);
      return;
    }

    if (key.tab) {
      setOverlay('selector');
      return;
    }
    if (key.upArrow) {
      setSelectedProcess(Math.max(0, selectedIndex - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedProcess(Math.min(Math.max(processes.length - 1, 0), selectedIndex + 1));
      return;
    }
    if ((key.return || input === 'x' || input === 'X') && selectedInfo !== undefined) {
      if (monitor.snapshot?.deployLock != null) {
        monitor.appendEvent(chalk.red('Restart blocked: a deploy is in progress (lock held)'));
        return;
      }
      setOverlay('confirmRestart');
      return;
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
  });

  if (overlay === 'help') {
    return <HelpOverlay />;
  }

  if (overlay === 'confirmRestart' && selectedInfo !== undefined) {
    const dropsRequests = selectedInfo.execMode !== 'cluster' || selectedInfo.instances <= 1;
    return (
      <ConfirmDialog
        title={`Restart ${selectedInfo.pm2Name}?`}
        lines={dropsRequests ? ['Single-instance process — restart drops in-flight requests.'] : []}
        onConfirm={() => {
          void confirmRestart();
        }}
        onCancel={() => setOverlay('none')}
      />
    );
  }

  if (overlay === 'selector') {
    return (
      <AppSelector
        apps={apps}
        targetName={targetName}
        onSelect={(app) => {
          setCurrentApp(app);
          setOverlay('none');
          setView('dashboard');
          setLogFilter(null);
          setSelectedProcess(0);
          monitor.reset();
          liveLogs.clearLogs();
          setLiveMode(false);
          monitor.appendEvent(chalk.green(`Switched to ${chalk.bold(app.name)}`));
        }}
        onCancel={() => setOverlay('none')}
      />
    );
  }

  if (view === 'logs') {
    const rows = stdout?.rows ?? 24;
    const title =
      currentApp.appType === 'frontend'
        ? `Caddy Access Log — ${currentApp.name}`
        : `Live Logs — ${logFilter ?? 'all processes'}  (←/→ filter, F back)`;
    return (
      <MonitorFrame
        app={currentApp}
        targetName={targetName}
        host={host}
        interval={interval}
        liveMode={liveActive}
        lastUpdate={monitor.lastUpdate}
        snapshot={monitor.snapshot}
        polling={monitor.polling}
        error={monitor.error}
      >
        <Box flexGrow={1}>
          <LogPanel logBuffer={liveLogs.logBuffer} maxLines={Math.max(10, rows - 6)} title={title} />
        </Box>
      </MonitorFrame>
    );
  }

  return (
    <MonitorFrame
      app={currentApp}
      targetName={targetName}
      host={host}
      interval={interval}
      liveMode={liveActive}
      lastUpdate={monitor.lastUpdate}
      snapshot={monitor.snapshot}
      polling={monitor.polling}
      error={monitor.error}
    >
      <Box flexGrow={1} flexDirection="row" minHeight={8}>
        <Box width="60%" flexDirection="column">
          {currentApp.appType === 'frontend' ? (
            <StaticFrontendPanel app={currentApp} caddy={monitor.snapshot?.caddy ?? null} />
          ) : monitor.snapshot ? (
            <Pm2Panel
              processes={monitor.snapshot.processes}
              cpuHistory={monitor.history.cpu}
              memHistory={monitor.history.memory}
              health={monitor.snapshot.health}
              responseHistory={monitor.history.responseMs}
              selectedIndex={selectedIndex}
            />
          ) : (
            <WaitingPanel />
          )}
        </Box>
        <Box width="40%" flexDirection="column">
          {monitor.snapshot ? (
            <>
              <SystemPanel
                system={monitor.snapshot.system}
                cpuHistory={monitor.history.cpu}
                memHistory={monitor.history.memory}
              />
              {accessoryNames.length > 0 && (
                <AccessoriesPanel
                  configuredNames={accessoryNames}
                  accessories={monitor.snapshot.accessories}
                />
              )}
            </>
          ) : (
            <WaitingPanel />
          )}
        </Box>
      </Box>

      {monitor.snapshot && (
        <Box height={accessoryNames.length > 0 ? 6 : 7}>
          <ReleasePanel
            currentRelease={monitor.snapshot.currentRelease}
            releases={monitor.snapshot.releases}
            maxReleases={accessoryNames.length > 0 ? 4 : 5}
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

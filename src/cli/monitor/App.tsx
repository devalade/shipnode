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
import { restartProcess, rollbackToRelease } from './actions.js';
import chalk from 'chalk';
import { useMonitorData, HEALTH_ALERT_THRESHOLD } from './hooks/use-monitor-data.js';
import { useLiveLogs } from './hooks/use-live-logs.js';
import { MonitorFrame, WaitingPanel } from './layout/MonitorFrame.js';

type View = 'dashboard' | 'logs';
type Overlay = 'none' | 'selector' | 'help' | 'confirmRestart' | 'confirmRollback';

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
  const [logSearch, setLogSearch] = useState('');
  const [searchTyping, setSearchTyping] = useState(false);
  const [logsPaused, setLogsPaused] = useState(false);
  const [selectedRow, setSelectedRow] = useState(0);
  const monitor = useMonitorData(executor, config, currentApp, interval, accessoryNames);
  const liveActive = liveMode || view === 'logs';
  const liveLogs = useLiveLogs(executor, currentApp, liveActive && !logsPaused, interval, logFilter);

  // On the 24-row terminals this layout was tuned for, the releases box has
  // room for exactly one row; taller terminals get a few more so a rollback
  // selection made with ↑/↓ is actually visible before confirming.
  const terminalRows = stdout?.rows ?? 24;
  const releaseBoxExtra = Math.max(0, Math.min(6, terminalRows - 30));

  // Selection runs over processes first, then the visible release rows, so
  // ↓ walks straight from the PM2 panel into the Releases panel.
  const processes = monitor.snapshot?.processes ?? [];
  const maxReleases = accessoryNames.length > 0 ? 4 : 5;
  const releaseRows = (monitor.snapshot?.releases ?? []).slice(0, maxReleases);
  const totalRows = processes.length + releaseRows.length;
  const selectedIndex = totalRows === 0 ? 0 : Math.min(selectedRow, totalRows - 1);
  const selectedInfo = selectedIndex < processes.length ? processes[selectedIndex] : undefined;
  const selectedRelease =
    selectedIndex >= processes.length ? releaseRows[selectedIndex - processes.length] : undefined;
  const currentTimestamp = monitor.snapshot?.currentRelease?.split('/').pop() ?? null;
  const alertStreak =
    monitor.healthFailStreak >= HEALTH_ALERT_THRESHOLD ? monitor.healthFailStreak : 0;

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

  const confirmRollback = async (): Promise<void> => {
    setOverlay('none');
    if (selectedRelease === undefined) return;
    monitor.appendEvent(chalk.yellow(`Rolling back to ${selectedRelease.timestamp}…`));
    const result = await rollbackToRelease(executor, config, currentApp, selectedRelease.timestamp);
    if (result.isOk()) {
      monitor.appendEvent(chalk.green(`Rolled back to ${chalk.bold(selectedRelease.timestamp)}`));
    } else {
      monitor.appendEvent(chalk.red(result.error.message));
    }
    void monitor.refresh();
  };

  const exitLogsView = (): void => {
    setView('dashboard');
    setSearchTyping(false);
    setLogSearch('');
    setLogsPaused(false);
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

    // While typing a search query every printable key belongs to the query,
    // including q/f/r — this branch must stay ahead of the global bindings.
    if (view === 'logs' && searchTyping) {
      if (key.return) {
        setSearchTyping(false);
        return;
      }
      if (key.escape) {
        setSearchTyping(false);
        setLogSearch('');
        return;
      }
      if (key.backspace || key.delete) {
        setLogSearch((s) => s.slice(0, -1));
        return;
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        setLogSearch((s) => s + input);
      }
      return;
    }

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
      if (view === 'logs') exitLogsView();
      else setView('logs');
      return;
    }

    if (view === 'logs') {
      if (key.escape) exitLogsView();
      if (key.leftArrow) cycleLogFilter(-1);
      if (key.rightArrow) cycleLogFilter(1);
      if (input === '/') {
        setSearchTyping(true);
        setLogSearch('');
      }
      if (input === ' ') setLogsPaused((p) => !p);
      return;
    }

    if (key.tab) {
      setOverlay('selector');
      return;
    }
    if (key.upArrow) {
      setSelectedRow(Math.max(0, selectedIndex - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedRow(Math.min(Math.max(totalRows - 1, 0), selectedIndex + 1));
      return;
    }
    if (key.return || input === 'x' || input === 'X') {
      if (selectedInfo !== undefined) {
        if (monitor.snapshot?.deployLock != null) {
          monitor.appendEvent(chalk.red('Restart blocked: a deploy is in progress (lock held)'));
          return;
        }
        setOverlay('confirmRestart');
        return;
      }
      if (selectedRelease !== undefined) {
        if (monitor.snapshot?.deployLock != null) {
          monitor.appendEvent(chalk.red('Rollback blocked: a deploy is in progress (lock held)'));
          return;
        }
        if (selectedRelease.status !== 'success') {
          monitor.appendEvent(chalk.red('Cannot roll back to a failed release'));
          return;
        }
        if (selectedRelease.timestamp === currentTimestamp) {
          monitor.appendEvent(chalk.yellow(`${selectedRelease.timestamp} is already the current release`));
          return;
        }
        setOverlay('confirmRollback');
        return;
      }
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

  if (overlay === 'confirmRollback' && selectedRelease !== undefined) {
    return (
      <ConfirmDialog
        title={`Rollback ${currentApp.name} to ${selectedRelease.timestamp}?`}
        lines={
          currentApp.appType === 'backend'
            ? ['Switches the current symlink and reloads PM2 from that release.']
            : ['Switches the current symlink.']
        }
        onConfirm={() => {
          void confirmRollback();
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
          exitLogsView();
          setLogFilter(null);
          setSelectedRow(0);
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
        : `Live Logs — ${logFilter ?? 'all processes'}  (←/→ filter, / search, space pause, F back)`;
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
        healthFailStreak={alertStreak}
      >
        <Box flexGrow={1}>
          <LogPanel
            logBuffer={liveLogs.logBuffer}
            maxLines={Math.max(10, rows - 6)}
            title={title}
            search={logSearch}
            searchTyping={searchTyping}
            paused={logsPaused}
          />
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
      healthFailStreak={alertStreak}
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
              selectedIndex={selectedInfo !== undefined ? selectedIndex : undefined}
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
        <Box height={(accessoryNames.length > 0 ? 6 : 7) + releaseBoxExtra}>
          <ReleasePanel
            currentRelease={monitor.snapshot.currentRelease}
            releases={monitor.snapshot.releases}
            maxReleases={maxReleases}
            selectedIndex={
              selectedRelease !== undefined ? selectedIndex - processes.length : undefined
            }
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

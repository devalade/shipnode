import { Box, useApp, useInput, useStdout } from 'ink';
import { useEffect, useReducer, useRef, useState } from 'react';
import { HEALTH_ALERT_THRESHOLD } from '../../services/observe/session.js';
import type { ObserveEvent } from '../../services/observe/events.js';
import { applyLogFilter, countLevels, logFacets } from '../../domain/observe/log-filter.js';
import type { FleetConnection } from '../observe.js';
import { Pm2Panel } from './panels/Pm2Panel.js';
import { SystemPanel } from './panels/SystemPanel.js';
import { ReleasePanel } from './panels/ReleasePanel.js';
import { EventsPanel } from './panels/EventsPanel.js';
import { FleetPanel } from './panels/FleetPanel.js';
import { LogViewer } from './panels/LogViewer.js';
import { StaticFrontendPanel } from './panels/StaticFrontendPanel.js';
import { AccessoriesPanel } from './panels/AccessoriesPanel.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { ConfirmDialog } from './components/ConfirmDialog.js';
import { restartProcess, rollbackToRelease } from './actions.js';
import { MonitorFrame, WaitingPanel } from './layout/MonitorFrame.js';
import type { HeaderAlert } from './layout/HeaderBar.js';
import { buildFleetRows, toMetricsSnapshot } from './fleet-model.js';
import { INITIAL_LOG_VIEW, logViewReducer } from './log-view-state.js';
import { useFleet } from './hooks/use-fleet.js';
import { useLogStream } from './hooks/use-log-stream.js';

type View = 'fleet' | 'detail' | 'logs';
type Overlay = 'none' | 'help' | 'confirmRestart' | 'confirmRollback';

/** Rows the logs view spends on everything but log lines: header, status, border, title, filter bar, source warning. */
const LOGS_CHROME_ROWS = 9;
const STRIP_ROWS = 5;
const MAX_ALERTS = 3;

interface AppProps {
  fleet: FleetConnection;
  interval: number;
  /** Open on this app instead of the fleet overview. */
  focusApp?: string;
}

export function App({ fleet: connection, interval, focusApp }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { state, session, refresh } = useFleet(connection.targets, interval);
  const [view, setView] = useState<View>('fleet');
  const [returnTo, setReturnTo] = useState<Exclude<View, 'logs'>>('fleet');
  const [overlay, setOverlay] = useState<Overlay>('none');
  const [stripOn, setStripOn] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [detailRow, setDetailRow] = useState(0);
  const [logView, dispatchLog] = useReducer(logViewReducer, INITIAL_LOG_VIEW);

  const rows = buildFleetRows(state.fleets);
  const logs = useLogStream(connection.hosts, stripOn || view === 'logs');
  const terminalRows = stdout?.rows ?? 24;

  // ── Fleet selection ──────────────────────────────────────────────
  const selectedAt = Math.max(0, rows.findIndex((row) => row.key === selectedKey));
  const selected = rows[selectedAt];

  // A fleet of one is not worth an overview: open it directly, once.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || rows.length === 0) return;
    autoOpened.current = true;
    const focus = focusApp === undefined ? undefined : rows.find((row) => row.app === focusApp);
    const target = rows.length === 1 ? rows[0] : focus;
    if (target !== undefined && rows.length === 1) {
      setDetailKey(target.key);
      setView('detail');
      setReturnTo('detail');
    }
    setSelectedKey((focus ?? rows[0]).key);
  }, [rows.length]);

  // ── Detail target ────────────────────────────────────────────────
  const detail = view === 'detail' || overlay.startsWith('confirm') ? rows.find((row) => row.key === detailKey) : undefined;
  const detailHost = detail === undefined ? undefined : connection.hosts.find((host) => host.name === detail.server);
  const detailApp = detail === undefined ? undefined : detailHost?.apps.find((app) => app.name === detail.app);
  const detailServer = detail === undefined ? undefined : state.servers.find((server) => server.server === detail.server);
  const detailSnapshot = detailServer !== undefined && detail?.snapshot !== undefined ? toMetricsSnapshot(detailServer, detail.snapshot) : null;
  const detailHistory = detail === undefined ? undefined : session.history(detail.server, detail.app);

  const processes = detailSnapshot?.processes ?? [];
  const maxReleases = (detailHost?.accessoryNames.length ?? 0) > 0 ? 4 : 5;
  const releaseRows = (detailSnapshot?.releases ?? []).slice(0, maxReleases);
  const totalDetailRows = processes.length + releaseRows.length;
  const detailIndex = totalDetailRows === 0 ? 0 : Math.min(detailRow, totalDetailRows - 1);
  const selectedProcess = detailIndex < processes.length ? processes[detailIndex] : undefined;
  const selectedRelease = detailIndex >= processes.length ? releaseRows[detailIndex - processes.length] : undefined;
  const currentTimestamp = detailSnapshot?.currentRelease?.split('/').pop() ?? null;
  const releaseBoxExtra = Math.max(0, Math.min(6, terminalRows - 30));

  // ── Logs ─────────────────────────────────────────────────────────
  const source = logView.frozen ?? logs.lines;
  const filtered = applyLogFilter(source, logView.filter);
  const counts = countLevels(source, logView.filter);
  const facets = logFacets(logs.lines, logView.filter);
  const serverNames = connection.hosts.map((host) => host.name).sort();
  const showServer = serverNames.length > 1;
  const showApp = new Set(logs.lines.map((line) => line.app)).size > 1;
  const troubled = logs.health.filter((entry) => entry.state !== 'live');
  const logHeight = Math.max(3, terminalRows - LOGS_CHROME_ROWS);
  const maxScroll = Math.max(0, filtered.lines.length - logHeight);

  // ── Alerts ───────────────────────────────────────────────────────
  const alerts: HeaderAlert[] = [];
  for (const server of state.servers) {
    if (server.error !== undefined) alerts.push({ text: `${server.server} DOWN` });
    else if (server.deployLock != null) alerts.push({ text: `DEPLOY LOCK ${server.server} (${server.deployLock.ageSeconds}s)` });
  }
  for (const row of state.fleets.flatMap((f) => f.replicas.map((r) => ({ app: f.app, server: r.server })))) {
    const streak = session.healthFailStreak(row.server, row.app);
    if (streak >= HEALTH_ALERT_THRESHOLD) alerts.push({ text: `HEALTH ${row.app}@${row.server} ×${streak}` });
  }
  const shownAlerts = alerts.slice(0, MAX_ALERTS);
  if (alerts.length > MAX_ALERTS) shownAlerts.push({ text: `+${alerts.length - MAX_ALERTS} more` });

  // Ring the terminal bell once when a health check starts failing.
  const lastEvent = useRef<ObserveEvent | undefined>(undefined);
  useEffect(() => {
    const events = state.events;
    const from = lastEvent.current === undefined ? 0 : events.indexOf(lastEvent.current) + 1;
    if (events.slice(from).some((event) => event.kind === 'health-failing')) stdout?.write('\x07');
    lastEvent.current = events[events.length - 1];
  }, [state.events]);

  // ── Actions ──────────────────────────────────────────────────────
  const confirmRestart = async (): Promise<void> => {
    setOverlay('none');
    if (selectedProcess === undefined || detailHost?.executor == null) return;
    session.notice(`Restarting ${selectedProcess.pm2Name} on ${detailHost.name}…`);
    const result = await restartProcess(detailHost.executor, selectedProcess.pm2Name, selectedProcess.supervisor);
    session.notice(result.isOk() ? `Restarted ${selectedProcess.pm2Name} on ${detailHost.name}` : result.error.message);
    void refresh();
  };

  const confirmRollback = async (): Promise<void> => {
    setOverlay('none');
    if (selectedRelease === undefined || detailHost?.executor == null || detailApp === undefined) return;
    session.notice(`Rolling back ${detailApp.name} on ${detailHost.name} to ${selectedRelease.timestamp}…`);
    const result = await rollbackToRelease(detailHost.executor, detailHost.config, detailApp, selectedRelease.timestamp);
    session.notice(result.isOk() ? `Rolled back to ${selectedRelease.timestamp}` : result.error.message);
    void refresh();
  };

  const openLogs = (from: Exclude<View, 'logs'>): void => {
    const scope = from === 'detail' ? detail : selected;
    dispatchLog({ type: 'enter', server: from === 'detail' ? (scope?.server ?? null) : null, app: scope?.app ?? null });
    setReturnTo(from);
    setView('logs');
  };

  const closeLogs = (): void => {
    dispatchLog({ type: 'resume' });
    setView(returnTo);
  };

  // ── Keys ─────────────────────────────────────────────────────────
  useInput((input, key) => {
    if (overlay === 'help') {
      setOverlay('none');
      return;
    }
    if (overlay !== 'none') return;

    // While typing a search query every printable key belongs to the query,
    // including q/f/r - this branch must stay ahead of the global bindings.
    if (view === 'logs' && logView.typing) {
      if (key.return) dispatchLog({ type: 'commit-search' });
      else if (key.escape) dispatchLog({ type: 'cancel-search' });
      else if (key.backspace || key.delete) dispatchLog({ type: 'backspace' });
      else if (input !== '' && !key.ctrl && !key.meta) dispatchLog({ type: 'type', text: input });
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
      void refresh();
      session.notice('Refresh triggered');
      return;
    }

    if (view === 'logs') {
      if (input === 'f' || input === 'F' || key.escape) return closeLogs();
      if (input === 's' || input === 'S') return dispatchLog({ type: 'cycle', dimension: 'server', direction: input === 's' ? 1 : -1, facets });
      if (input === 'a' || input === 'A') return dispatchLog({ type: 'cycle', dimension: 'app', direction: input === 'a' ? 1 : -1, facets });
      if (input === 'p' || input === 'P') return dispatchLog({ type: 'cycle', dimension: 'process', direction: input === 'p' ? 1 : -1, facets });
      if (input === 'v') return dispatchLog({ type: 'cycle-level' });
      if (input === 'm') return dispatchLog({ type: 'toggle-mode' });
      if (input === '/') return dispatchLog({ type: 'start-search' });
      if (input === 'c') return dispatchLog({ type: 'clear-filters' });
      if (input === 'C') {
        dispatchLog({ type: 'resume' });
        return logs.clear();
      }
      if (input === ' ') return dispatchLog({ type: 'toggle-pause', live: logs.lines });
      if (input === 'G' || key.end) return dispatchLog({ type: 'resume' });
      if (key.upArrow) return dispatchLog({ type: 'scroll', delta: 1, live: logs.lines, max: maxScroll });
      if (key.downArrow) return dispatchLog({ type: 'scroll', delta: -1, live: logs.lines, max: maxScroll });
      if (key.pageUp) return dispatchLog({ type: 'scroll', delta: logHeight - 1, live: logs.lines, max: maxScroll });
      if (key.pageDown) return dispatchLog({ type: 'scroll', delta: -(logHeight - 1), live: logs.lines, max: maxScroll });
      return;
    }

    if (input === 'f' || input === 'F') return openLogs(view);
    if (input === 'l' || input === 'L') {
      setStripOn((on) => !on);
      return;
    }

    if (view === 'fleet') {
      if (key.upArrow) setSelectedKey(rows[Math.max(0, selectedAt - 1)]?.key ?? null);
      else if (key.downArrow) setSelectedKey(rows[Math.min(rows.length - 1, selectedAt + 1)]?.key ?? null);
      else if (key.return && selected !== undefined) {
        setDetailKey(selected.key);
        setDetailRow(0);
        setReturnTo('fleet');
        setView('detail');
      }
      return;
    }

    // detail
    if (key.escape) {
      setView('fleet');
      return;
    }
    if (key.upArrow) return setDetailRow(Math.max(0, detailIndex - 1));
    if (key.downArrow) return setDetailRow(Math.min(Math.max(totalDetailRows - 1, 0), detailIndex + 1));
    if (key.return || input === 'x' || input === 'X') {
      if (detailSnapshot?.deployLock != null) {
        session.notice(`Blocked: a deploy is in progress on ${detail?.server} (lock held)`);
        return;
      }
      if (selectedProcess !== undefined) return setOverlay('confirmRestart');
      if (selectedRelease !== undefined) {
        if (detail?.replicated === true) {
          session.notice(`Rollback on one replica of ${detail.app} would split the fleet - use 'shipnode rollback'`);
          return;
        }
        if (selectedRelease.status !== 'success') {
          session.notice('Cannot roll back to a failed release');
          return;
        }
        if (selectedRelease.timestamp === currentTimestamp) {
          session.notice(`${selectedRelease.timestamp} is already the current release`);
          return;
        }
        setOverlay('confirmRollback');
      }
    }
  });

  // ── Overlays ─────────────────────────────────────────────────────
  if (overlay === 'help') return <HelpOverlay />;

  if (overlay === 'confirmRestart' && selectedProcess !== undefined) {
    const dropsRequests = selectedProcess.execMode !== 'cluster' || selectedProcess.instances <= 1;
    return (
      <ConfirmDialog
        title={`Restart ${selectedProcess.pm2Name} on ${detailHost?.name}?`}
        lines={dropsRequests ? ['Single-instance process — restart drops in-flight requests.'] : []}
        onConfirm={() => {
          void confirmRestart();
        }}
        onCancel={() => setOverlay('none')}
      />
    );
  }

  if (overlay === 'confirmRollback' && selectedRelease !== undefined && detailApp !== undefined) {
    return (
      <ConfirmDialog
        title={`Rollback ${detailApp.name} to ${selectedRelease.timestamp}?`}
        lines={
          detailApp.appType === 'backend'
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

  // ── Views ────────────────────────────────────────────────────────
  const unreachable = state.servers.filter((server) => server.error !== undefined).length;
  const frame = {
    interval,
    liveMode: stripOn || view === 'logs',
    alerts: shownAlerts,
    lastUpdate: state.lastUpdate,
    polling: state.polling,
  };

  if (view === 'logs') {
    const scope = [logView.filter.server, logView.filter.app].filter((part) => part !== null).join(' / ');
    return (
      <MonitorFrame
        {...frame}
        scope={scope === '' ? 'logs · all' : `logs · ${scope}`}
        summary={`${filtered.lines.length}/${source.length} lines · ${logs.health.length - troubled.length}/${logs.health.length} sources live`}
        hints="s/a/p server·app·proc  v level  / search  m mode  space pause  c clear"
        error={logs.skipped.length > 0 ? `no logs from ${logs.skipped.join(', ')}` : null}
      >
        <Box flexGrow={1}>
          <LogViewer
            title="Live Logs"
            lines={filtered.lines}
            matched={filtered.matched}
            filter={logView.filter}
            servers={serverNames}
            showServer={showServer}
            showApp={showApp}
            height={logHeight}
            offset={logView.offset}
            frozen={logView.frozen !== null}
            typing={logView.typing}
            queryError={filtered.queryError}
            counts={counts}
            troubled={troubled}
            totalSources={logs.health.length}
          />
        </Box>
      </MonitorFrame>
    );
  }

  const bottom = stripOn ? (
    <LogViewer
      compact
      title="Live Logs"
      lines={filtered.lines}
      matched={filtered.matched}
      filter={logView.filter}
      servers={serverNames}
      showServer={showServer}
      showApp={showApp}
      height={STRIP_ROWS}
      offset={0}
      frozen={logView.frozen !== null}
      typing={false}
      troubled={troubled}
      totalSources={logs.health.length}
    />
  ) : (
    <EventsPanel events={state.events} />
  );

  if (view === 'fleet') {
    return (
      <MonitorFrame
        {...frame}
        scope={`fleet · ${connection.hosts.length} server${connection.hosts.length === 1 ? '' : 's'}`}
        summary={`${state.fleets.length} app(s)${unreachable > 0 ? ` · ${unreachable} down` : ''}`}
        hints="↑/↓ select  Enter open  f logs  l strip"
      >
        <Box flexGrow={1} minHeight={8}>
          <FleetPanel
            fleets={state.fleets}
            rows={rows}
            servers={state.servers}
            selectedKey={selected?.key ?? null}
            height={Math.max(4, terminalRows - 8 - 4)}
          />
        </Box>
        <Box height={8}>{bottom}</Box>
      </MonitorFrame>
    );
  }

  // detail
  const unavailable = detail?.reachable === false ? (detail.error ?? 'server unreachable') : null;
  return (
    <MonitorFrame
      {...frame}
      scope={detail === undefined ? 'detail' : `${detail.app} (${detail.appType}) on ${detail.server}`}
      summary={detailSnapshot ? `${processes.length} process(es)` : '-'}
      hints={`Esc back  ↑/↓ select  Enter restart/rollback  f logs`}
      error={unavailable}
    >
      <Box flexGrow={1} flexDirection="row" minHeight={8}>
        <Box width="60%" flexDirection="column">
          {detailApp?.appType === 'frontend' ? (
            <StaticFrontendPanel app={detailApp} caddy={detailSnapshot?.caddy ?? null} />
          ) : detailSnapshot && detailHistory ? (
            <Pm2Panel
              processes={detailSnapshot.processes}
              cpuHistory={detailHistory.cpu}
              memHistory={detailHistory.memory}
              health={detailSnapshot.health}
              responseHistory={detailHistory.responseMs}
              selectedIndex={selectedProcess !== undefined ? detailIndex : undefined}
            />
          ) : (
            <WaitingPanel />
          )}
        </Box>
        <Box width="40%" flexDirection="column">
          {detailSnapshot && detailHistory ? (
            <>
              <SystemPanel system={detailSnapshot.system} cpuHistory={detailHistory.cpu} memHistory={detailHistory.memory} />
              {(detailHost?.accessoryNames.length ?? 0) > 0 && (
                <AccessoriesPanel configuredNames={detailHost?.accessoryNames ?? []} accessories={detailSnapshot.accessories} />
              )}
            </>
          ) : (
            <WaitingPanel />
          )}
        </Box>
      </Box>

      {detailSnapshot && (
        <Box height={((detailHost?.accessoryNames.length ?? 0) > 0 ? 6 : 7) + releaseBoxExtra}>
          <ReleasePanel
            currentRelease={detailSnapshot.currentRelease}
            releases={detailSnapshot.releases}
            maxReleases={maxReleases}
            selectedIndex={selectedRelease !== undefined ? detailIndex - processes.length : undefined}
          />
        </Box>
      )}

      <Box height={8}>{bottom}</Box>
    </MonitorFrame>
  );
}

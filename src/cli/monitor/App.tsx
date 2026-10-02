import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useEffect, useReducer, useRef, useState } from 'react';
import { HEALTH_ALERT_THRESHOLD } from '../../services/observe/session.js';
import type { ObserveEvent } from '../../services/observe/events.js';
import { applyLogFilter, countLevels, logFacets } from '../../domain/observe/log-filter.js';
import type { FleetConnection } from '../observe.js';
import { Pm2Panel } from './panels/Pm2Panel.js';
import { SystemPanel } from './panels/SystemPanel.js';
import { ReleasePanel, releasePanelHeight } from './panels/ReleasePanel.js';
import { EventsPanel } from './panels/EventsPanel.js';
import { AppsPanel, ServersPanel, serversPanelHeight } from './panels/FleetPanel.js';
import { LOG_VIEWER_CHROME, LogViewer } from './panels/LogViewer.js';
import { StaticFrontendPanel } from './panels/StaticFrontendPanel.js';
import { AccessoriesPanel } from './panels/AccessoriesPanel.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { ConfirmDialog } from './components/ConfirmDialog.js';
import { restartProcess, rollbackToRelease } from './actions.js';
import { MonitorFrame, type Flash, type HeaderAlert } from './layout/MonitorFrame.js';
import { Panel } from './components/Panel.js';
import type { Hint } from './components/KeyHints.js';
import type { Tone } from './theme.js';
import { buildFleetRows, toMetricsSnapshot } from './fleet-model.js';
import { INITIAL_LOG_VIEW, logViewReducer } from './log-view-state.js';
import { useFleet } from './hooks/use-fleet.js';
import { useLogStream } from './hooks/use-log-stream.js';

type View = 'fleet' | 'detail' | 'logs';
type Overlay = 'none' | 'help' | 'confirmRestart' | 'confirmRollback';

/** Lines of log or activity in the strip under the fleet and replica views. */
const STRIP_ROWS = 5;
/** The strip's panel: its lines plus top and bottom edges. */
const BOTTOM_HEIGHT = STRIP_ROWS + 2;
const MAX_ALERTS = 3;
const FLASH_MS = 4000;

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
  const [flash, setFlash] = useState<Flash | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Say something in the footer for a moment. */
  const showFlash = (next: Flash): void => {
    setFlash(next);
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  };

  /** Flash it and keep it in the activity log. */
  const notify = (tone: Tone, text: string): void => {
    session.notice(text);
    showFlash({ tone, text });
  };
  useEffect(() => () => {
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
  }, []);

  const rows = buildFleetRows(state.fleets);
  const logs = useLogStream(connection.hosts, stripOn || view === 'logs');
  const terminalRows = stdout?.rows ?? 24;
  const terminalCols = stdout?.columns ?? 100;

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

  // ── Logs ─────────────────────────────────────────────────────────
  const source = logView.frozen ?? logs.lines;
  const filtered = applyLogFilter(source, logView.filter);
  const counts = countLevels(source, logView.filter);
  const facets = logFacets(logs.lines, logView.filter);
  const serverNames = connection.hosts.map((host) => host.name).sort();
  const showServer = serverNames.length > 1;
  const showApp = new Set(logs.lines.map((line) => line.app)).size > 1;
  const troubled = logs.health.filter((entry) => entry.state !== 'live');

  // ── Alerts ───────────────────────────────────────────────────────
  const alerts: HeaderAlert[] = [];
  for (const server of state.servers) {
    if (server.error !== undefined) alerts.push({ text: `${server.server} unreachable` });
    else if (server.deployLock != null) alerts.push({ text: `${server.server} deploy lock ${server.deployLock.ageSeconds}s` });
  }
  for (const row of state.fleets.flatMap((f) => f.replicas.map((r) => ({ app: f.app, server: r.server })))) {
    const streak = session.healthFailStreak(row.server, row.app);
    if (streak >= HEALTH_ALERT_THRESHOLD) alerts.push({ text: `${row.app} on ${row.server} health failing ×${streak}` });
  }
  const shownAlerts = alerts.slice(0, MAX_ALERTS);
  if (alerts.length > MAX_ALERTS) shownAlerts.push({ text: `+${alerts.length - MAX_ALERTS} more` });

  // ── Height budget ────────────────────────────────────────────────
  // Every view gets the terminal minus the header, the alert bar when shown, and the footer.
  const bodyHeight = Math.max(8, terminalRows - 2 - (shownAlerts.length > 0 ? 1 : 0));
  const logHeight = Math.max(3, bodyHeight - LOG_VIEWER_CHROME);
  const maxScroll = Math.max(0, filtered.lines.length - logHeight);

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
    notify('info', `Restarting ${selectedProcess.pm2Name} on ${detailHost.name}…`);
    const result = await restartProcess(detailHost.executor, selectedProcess.pm2Name, selectedProcess.supervisor);
    if (result.isOk()) notify('ok', `Restarted ${selectedProcess.pm2Name} on ${detailHost.name}`);
    else notify('bad', result.error.message);
    void refresh();
  };

  const confirmRollback = async (): Promise<void> => {
    setOverlay('none');
    if (selectedRelease === undefined || detailHost?.executor == null || detailApp === undefined) return;
    notify('info', `Rolling back ${detailApp.name} on ${detailHost.name} to ${selectedRelease.timestamp}…`);
    const result = await rollbackToRelease(detailHost.executor, detailHost.config, detailApp, selectedRelease.timestamp);
    if (result.isOk()) notify('ok', `Rolled back ${detailApp.name} to ${selectedRelease.timestamp}`);
    else notify('bad', result.error.message);
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
      showFlash({ tone: 'muted', text: 'refreshing…' });
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
        notify('bad', `A deploy holds the lock on ${detail?.server} - try again when it finishes`);
        return;
      }
      if (selectedProcess !== undefined) return setOverlay('confirmRestart');
      if (selectedRelease !== undefined) {
        if (detail?.replicated === true) {
          notify('warn', `Rolling back one replica would split ${detail.app} - use 'shipnode rollback'`);
          return;
        }
        if (selectedRelease.status !== 'success') {
          notify('warn', 'That release failed to deploy - pick a successful one');
          return;
        }
        if (selectedRelease.timestamp === currentTimestamp) {
          notify('muted', `${selectedRelease.timestamp} is already current`);
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
  const frame = {
    interval,
    polling: state.polling,
    lastUpdate: state.lastUpdate,
    streaming: logs.health.length > 0 ? { live: logs.health.length - troubled.length, total: logs.health.length } : null,
    alerts: shownAlerts,
    flash,
  };

  const viewerProps = {
    matched: filtered.matched,
    filter: logView.filter,
    total: source.length,
    servers: serverNames,
    showServer,
    showApp,
    frozen: logView.frozen !== null,
    health: logs.health,
  };

  if (view === 'logs') {
    const scope = [logView.filter.server, logView.filter.app].filter((part): part is string => part !== null);
    const hints: Hint[] = logView.typing
      ? [['⏎', 'keep search'], ['esc', 'drop search']]
      : [['s a p', 'server·app·proc'], ['v', 'level'], ['/', 'search'], ['space', logView.frozen ? 'resume' : 'pause'], ['c', 'clear'], ['esc', 'back']];
    return (
      <MonitorFrame {...frame} crumbs={['logs', ...(scope.length > 0 ? scope : ['everything'])]} hints={hints}>
        <LogViewer
          {...viewerProps}
          focused
          lines={filtered.lines}
          height={logHeight}
          offset={logView.offset}
          typing={logView.typing}
          queryError={filtered.queryError}
          counts={counts}
        />
      </MonitorFrame>
    );
  }

  const bottom = stripOn ? (
    <LogViewer {...viewerProps} compact lines={filtered.lines} height={STRIP_ROWS} offset={0} typing={false} />
  ) : (
    <EventsPanel events={state.events} rows={STRIP_ROWS} />
  );

  if (view === 'fleet') {
    const serversHeight = serversPanelHeight(connection.hosts.length);
    // The apps panel takes what is left; its body loses the two edges and the column header.
    const appsBody = bodyHeight - serversHeight - BOTTOM_HEIGHT - 3;
    return (
      <MonitorFrame
        {...frame}
        crumbs={['fleet']}
        hints={[['↑↓', 'select'], ['⏎', 'open'], ['f', 'logs'], ['l', stripOn ? 'activity' : 'log strip'], ['r', 'refresh']]}
      >
        <AppsPanel width={terminalCols} fleets={state.fleets} rows={rows} selectedKey={selected?.key ?? null} height={appsBody} serverCount={connection.hosts.length} />
        <Box height={serversHeight} flexShrink={0}>
          <ServersPanel width={terminalCols} servers={state.servers} expected={connection.hosts.length} />
        </Box>
        <Box height={BOTTOM_HEIGHT} flexShrink={0}>{bottom}</Box>
      </MonitorFrame>
    );
  }

  // detail
  const crumbs = detail === undefined ? ['fleet', 'replica'] : ['fleet', detail.app, detail.server];
  const accessories = detailHost?.accessoryNames ?? [];
  const rollbackNote = detail?.replicated === true ? 'roll back fleets with shipnode rollback' : undefined;
  const hints: Hint[] = [
    ['↑↓', 'select'],
    ['⏎', selectedRelease !== undefined ? 'roll back' : 'restart'],
    ['f', 'logs'],
    ['l', stripOn ? 'activity' : 'log strip'],
    ['esc', 'fleet'],
  ];

  if (detail !== undefined && !detail.reachable) {
    return (
      <MonitorFrame {...frame} crumbs={crumbs} hints={[['esc', 'fleet'], ['f', 'logs']]}>
        <Panel title={detail.server} subtitle="unreachable" focused>
          <Text color="red">{detail.error ?? 'The last poll could not reach this server.'}</Text>
          <Text dimColor>The overview keeps polling; this view fills in once the server answers.</Text>
        </Panel>
      </MonitorFrame>
    );
  }

  // The host column is fixed; the process table takes the rest and drops columns to fit it.
  const sideWidth = terminalCols >= 120 ? 46 : terminalCols >= 100 ? 40 : 34;
  const mainWidth = terminalCols - sideWidth;

  const waiting = (
    <Panel title="Processes">
      <Text dimColor>Waiting for the first poll…</Text>
    </Panel>
  );

  return (
    <MonitorFrame {...frame} crumbs={crumbs} hints={hints}>
      <Box flexGrow={1} flexDirection="row" minHeight={8}>
        <Box flexGrow={1} flexDirection="column">
          {detailApp?.appType === 'frontend' ? (
            <StaticFrontendPanel app={detailApp} caddy={detailSnapshot?.caddy ?? null} />
          ) : detailSnapshot && detailHistory ? (
            <Pm2Panel
              width={mainWidth}
              focused={selectedProcess !== undefined}
              processes={detailSnapshot.processes}
              cpuHistory={detailHistory.cpu}
              memHistory={detailHistory.memory}
              health={detailSnapshot.health}
              responseHistory={detailHistory.responseMs}
              selectedIndex={selectedProcess !== undefined ? detailIndex : undefined}
            />
          ) : (
            waiting
          )}
        </Box>
        {detailSnapshot && detail !== undefined && (
          <Box width={sideWidth} flexShrink={0} flexDirection="column">
            <Box height={6} flexShrink={0}>
              <SystemPanel server={detail.server} system={detailSnapshot.system} />
            </Box>
            {accessories.length > 0 && (
              <Box flexGrow={1} flexDirection="column">
                <AccessoriesPanel configuredNames={accessories} accessories={detailSnapshot.accessories} />
              </Box>
            )}
          </Box>
        )}
      </Box>

      {detailSnapshot && (
        <Box height={releasePanelHeight(Math.min(releaseRows.length, maxReleases))} flexShrink={0}>
          <ReleasePanel
            width={terminalCols}
            currentRelease={detailSnapshot.currentRelease}
            releases={detailSnapshot.releases}
            maxReleases={maxReleases}
            selectedIndex={selectedRelease !== undefined ? detailIndex - processes.length : undefined}
            rollbackNote={rollbackNote}
          />
        </Box>
      )}

      <Box height={BOTTOM_HEIGHT} flexShrink={0}>{bottom}</Box>
    </MonitorFrame>
  );
}

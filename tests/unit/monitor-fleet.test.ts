import { describe, it, expect } from 'vitest';
import { buildFleetRows, describeEvent, describeFleet, toMetricsSnapshot } from '../../src/cli/monitor/fleet-model.js';
import { INITIAL_LOG_VIEW, logViewReducer, type LogViewState } from '../../src/cli/monitor/log-view-state.js';
import { pivotByApp } from '../../src/domain/observe/pivot.js';
import type { AppSnapshot, ServerSnapshot } from '../../src/domain/observe/snapshot.js';
import type { ProcessInfo } from '../../src/domain/observe/types.js';
import { parseSystemStats } from '../../src/domain/observe/parse.js';
import type { LogLine } from '../../src/domain/observe/log-line.js';
import { sourceLabel } from '../../src/cli/monitor/panels/LogViewer.js';

function proc(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    name: 'web', pm2Name: 'api-web', pid: 1, status: 'online', cpu: 10, memory: 100, uptime: 60,
    restarts: 0, execMode: 'cluster', instances: 2, unstableRestarts: 0, exitCode: null,
    ...overrides,
  };
}

function app(release: string | null, overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    app: 'api', appType: 'backend', processes: [proc()],
    currentRelease: release === null ? null : `/var/www/api/releases/${release}`,
    releases: [], ...overrides,
  };
}

function server(name: string, apps: AppSnapshot[], extra: Partial<ServerSnapshot> = {}): ServerSnapshot {
  return {
    server: name, timestamp: '2026-10-02T10:00:00Z', system: parseSystemStats(''),
    deployLock: null, apps, ...extra,
  };
}

describe('buildFleetRows', () => {
  it('gives one row per app per server, in fleet order', () => {
    const fleets = pivotByApp([server('a', [app('r2')]), server('b', [app('r2')])]);
    const rows = buildFleetRows(fleets);
    expect(rows.map((r) => [r.app, r.server, r.release])).toEqual([['api', 'a', 'r2'], ['api', 'b', 'r2']]);
    expect(rows.every((r) => r.replicated)).toBe(true);
  });

  it('marks the replica that is not on the newest release as behind while the fleet is split', () => {
    const rows = buildFleetRows(pivotByApp([server('a', [app('r2')]), server('b', [app('r1')])]));
    expect(rows.map((r) => r.releaseState)).toEqual(['current', 'behind']);
  });

  it('reads converged replicas as current', () => {
    const rows = buildFleetRows(pivotByApp([server('a', [app('r1')]), server('b', [app('r1')])]));
    expect(rows.map((r) => r.releaseState)).toEqual(['current', 'current']);
  });

  it('keeps a row for a replica that could not be reached', () => {
    const down = server('b', [], { error: 'timeout', plannedApps: [{ app: 'api', appType: 'backend' }] });
    const rows = buildFleetRows(pivotByApp([server('a', [app('r1')]), down]));
    expect(rows.map((r) => [r.server, r.reachable])).toEqual([['a', true], ['b', false]]);
    expect(rows[1].releaseState).toBe('unknown');
  });

  it('sums process counts, memory and restarts per replica', () => {
    const snapshot = app('r1', { processes: [proc({ restarts: 2 }), proc({ status: 'errored', restarts: 1, memory: 50 })] });
    const [row] = buildFleetRows(pivotByApp([server('a', [snapshot])]));
    expect([row.online, row.total, row.memoryMb, row.restarts]).toEqual([1, 2, 150, 3]);
    expect(row.replicated).toBe(false);
  });

  it('keeps a stable key per app and server', () => {
    const rows = buildFleetRows(pivotByApp([server('a', [app('r1')])]));
    expect(rows[0].key).toBe(buildFleetRows(pivotByApp([server('a', [app('r9')])]))[0].key);
  });
});

describe('describeFleet', () => {
  it('names unreachable replicas first, then a split roll, then a converged fleet', () => {
    const down = server('b', [], { error: 'x', plannedApps: [{ app: 'api', appType: 'backend' }] });
    expect(describeFleet(pivotByApp([server('a', [app('r1')]), down])[0]).tone).toBe('bad');
    expect(describeFleet(pivotByApp([server('a', [app('r2')]), server('b', [app('r1')])])[0]).text).toMatch(/split across 2 releases/);
    expect(describeFleet(pivotByApp([server('a', [app('r1')]), server('b', [app('r1')])])[0])).toEqual({
      tone: 'ok', text: 'converged on r1',
    });
  });

  it('warns about a replica with no release', () => {
    expect(describeFleet(pivotByApp([server('a', [app('r1')]), server('b', [app(null)])])[0]).tone).toBe('warn');
  });
});

describe('toMetricsSnapshot', () => {
  it('flattens host facts and app facts into the shape the panels take', () => {
    const s = server('a', [app('r1')], { deployLock: { lockedAt: 'now', ageSeconds: 5 } });
    const flat = toMetricsSnapshot(s, s.apps[0]);
    expect(flat.deployLock?.ageSeconds).toBe(5);
    expect(flat.processes).toHaveLength(1);
    expect(flat.currentRelease).toContain('r1');
  });
});

describe('describeEvent', () => {
  it('names the server so a fleet event is attributable', () => {
    expect(describeEvent({ kind: 'health-failing', at: '', server: 'b', app: 'api', streak: 3 }).text).toContain('api on b');
    expect(describeEvent({ kind: 'server-unreachable', at: '', server: 'b', message: 'timeout' }).tone).toBe('bad');
    expect(describeEvent({ kind: 'notice', at: '', message: 'hi' })).toEqual({ tone: 'info', text: 'hi' });
  });
});

// ── Log view reducer ──────────────────────────────────────────────

const facets = { servers: ['a', 'b'], apps: ['api', 'site'], processes: ['api-web', 'api-worker'] };
const liveLines = [{ id: 1 }, { id: 2 }] as LogLine[];

describe('logViewReducer', () => {
  const reduce = (state: LogViewState, ...actions: Parameters<typeof logViewReducer>[1][]) =>
    actions.reduce(logViewReducer, state);

  it('resets app and process when the server changes, and process when the app changes', () => {
    let state = reduce(INITIAL_LOG_VIEW, { type: 'cycle', dimension: 'app', direction: 1, facets });
    state = reduce(state, { type: 'cycle', dimension: 'process', direction: 1, facets });
    expect(state.filter).toMatchObject({ app: 'api', process: 'api-web' });

    const app = reduce(state, { type: 'cycle', dimension: 'app', direction: 1, facets });
    expect(app.filter).toMatchObject({ app: 'site', process: null });

    const srv = reduce(state, { type: 'cycle', dimension: 'server', direction: 1, facets });
    expect(srv.filter).toMatchObject({ server: 'a', app: null, process: null });
  });

  it('builds a query while typing and drops it on cancel but keeps it on commit', () => {
    let state = reduce(INITIAL_LOG_VIEW, { type: 'start-search' }, { type: 'type', text: 'ti' }, { type: 'type', text: 'me' });
    expect(state).toMatchObject({ typing: true, filter: { query: 'time' } });
    state = reduce(state, { type: 'backspace' });
    expect(state.filter.query).toBe('tim');
    expect(reduce(state, { type: 'commit-search' })).toMatchObject({ typing: false, filter: { query: 'tim' } });
    expect(reduce(state, { type: 'cancel-search' })).toMatchObject({ typing: false, filter: { query: '' } });
  });

  it('clears filters but keeps the chosen mode', () => {
    const state = reduce(INITIAL_LOG_VIEW, { type: 'toggle-mode' }, { type: 'cycle-level' }, { type: 'cycle', dimension: 'server', direction: 1, facets });
    const cleared = reduce(state, { type: 'clear-filters' });
    expect(cleared.filter).toMatchObject({ server: null, minLevel: null, mode: 'dim' });
  });

  it('freezes on the first scroll up and clamps the offset', () => {
    let state = reduce(INITIAL_LOG_VIEW, { type: 'scroll', delta: 1, live: liveLines, max: 3 });
    expect(state.frozen).toBe(liveLines);
    expect(state.offset).toBe(1);
    state = reduce(state, { type: 'scroll', delta: 10, live: liveLines, max: 3 });
    expect(state.offset).toBe(3);
    state = reduce(state, { type: 'scroll', delta: -10, live: liveLines, max: 3 });
    expect(state.offset).toBe(0);
    expect(state.frozen).toBe(liveLines);
  });

  it('ignores scrolling down while following', () => {
    expect(reduce(INITIAL_LOG_VIEW, { type: 'scroll', delta: -1, live: liveLines, max: 3 })).toBe(INITIAL_LOG_VIEW);
  });

  it('toggles pause and resumes at the tail', () => {
    const paused = reduce(INITIAL_LOG_VIEW, { type: 'toggle-pause', live: liveLines });
    expect(paused.frozen).toBe(liveLines);
    expect(reduce(paused, { type: 'toggle-pause', live: liveLines }).frozen).toBeNull();
    expect(reduce({ ...paused, offset: 2 }, { type: 'resume' })).toMatchObject({ frozen: null, offset: 0 });
  });

  it('enters scoped to what was being looked at', () => {
    const state = reduce(INITIAL_LOG_VIEW, { type: 'start-search' }, { type: 'type', text: 'x' }, { type: 'enter', server: 'b', app: 'api' });
    expect(state).toMatchObject({ typing: false, frozen: null, filter: { server: 'b', app: 'api', query: '' } });
  });
});

describe('sourceLabel', () => {
  const line = { server: 'b', app: 'api', process: 'api-web' } as LogLine;

  it('shows only the parts that vary on screen', () => {
    expect(sourceLabel(line, true, true)).toBe('b api:api-web');
    expect(sourceLabel(line, true, false)).toBe('b:api-web');
    expect(sourceLabel(line, false, false)).toBe('api-web');
  });

  it('omits a process that is just the app, or unknown', () => {
    expect(sourceLabel({ ...line, process: 'api' } as LogLine, true, true)).toBe('b api');
    expect(sourceLabel({ ...line, process: null } as LogLine, true, true)).toBe('b api');
    expect(sourceLabel({ ...line, process: null } as LogLine, false, false)).toBe('');
  });
});

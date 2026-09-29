import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ObserveSession,
  HEALTH_ALERT_THRESHOLD,
  MAX_CONCURRENT_POLLS,
  type ObserveTarget,
  type ServerObserver,
} from '../../src/services/observe/session.js';
import type { CollectRequest } from '../../src/domain/observe/collector.js';
import type { AppSnapshot, ServerSnapshot } from '../../src/domain/observe/snapshot.js';
import type { HealthInfo, SystemInfo } from '../../src/domain/observe/types.js';

const system: SystemInfo = {
  load1: 0.5, load5: 0.4, load15: 0.3, cores: 2,
  totalMem: 2048, usedMem: 1024, totalDisk: 40, usedDisk: 10, uptime: 100,
};

function appSnapshot(name: string, extra: Partial<AppSnapshot> = {}): AppSnapshot {
  return { app: name, appType: 'backend', processes: [], currentRelease: null, releases: [], ...extra };
}

/** A collector stand-in whose answers the test dictates tick by tick. */
class StubObserver implements ServerObserver {
  requests: CollectRequest[] = [];
  private queue: ServerSnapshot[] = [];

  constructor(
    readonly serverName: string,
    private fallback: ServerSnapshot,
    private onCollect?: () => Promise<void>,
  ) {}

  queueUp(...snapshots: ServerSnapshot[]): this {
    this.queue.push(...snapshots);
    return this;
  }

  async collect(request: CollectRequest): Promise<ServerSnapshot> {
    this.requests.push(request);
    if (this.onCollect) await this.onCollect();
    return this.queue.shift() ?? this.fallback;
  }
}

function serverSnapshot(server: string, apps: AppSnapshot[], extra: Partial<ServerSnapshot> = {}): ServerSnapshot {
  return { server, timestamp: '2026-08-30T00:00:00.000Z', system, deployLock: null, apps, ...extra };
}

function target(observer: ServerObserver, apps: string[] = ['api'], accessoryNames: string[] = []): ObserveTarget {
  return {
    observer,
    // Only the name is read by the session; the collector owns the rest.
    apps: apps.map((name) => ({ name }) as ObserveTarget['apps'][number]),
    accessoryNames,
  };
}

const healthy: HealthInfo = { status: 'ok', httpCode: 200, responseMs: 10 };
const failing: HealthInfo = { status: 'fail', httpCode: 502, responseMs: 5 };

describe('ObserveSession', () => {
  it('publishes both the server-shaped and app-shaped views of one tick', async () => {
    const a = new StubObserver('a', serverSnapshot('a', [appSnapshot('api', { currentRelease: '/x/releases/1' })]));
    const b = new StubObserver('b', serverSnapshot('b', [appSnapshot('api', { currentRelease: '/x/releases/1' })]));
    const session = new ObserveSession({ targets: [target(a), target(b)], intervalSeconds: 2 });

    await session.tick();
    const state = session.getState();

    expect(state.servers.map((s) => s.server)).toEqual(['a', 'b']);
    expect(state.fleets).toHaveLength(1);
    expect(state.fleets[0].convergence.converged).toBe(true);
    expect(state.lastUpdate).not.toBeNull();
  });

  it('surfaces release skew across replicas without a second poll', async () => {
    const a = new StubObserver('a', serverSnapshot('a', [appSnapshot('api', { currentRelease: '/x/releases/2' })]));
    const b = new StubObserver('b', serverSnapshot('b', [appSnapshot('api', { currentRelease: '/x/releases/1' })]));
    const session = new ObserveSession({ targets: [target(a), target(b)], intervalSeconds: 2 });

    await session.tick();

    expect(session.getState().fleets[0].convergence.converged).toBe(false);
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
  });

  it('keeps reporting the other servers when one is unreachable', async () => {
    const a = new StubObserver('a', serverSnapshot('a', [appSnapshot('api')]));
    const b = new StubObserver('b', serverSnapshot('b', [], { error: 'connect ETIMEDOUT' }));
    const session = new ObserveSession({ targets: [target(a), target(b)], intervalSeconds: 2 });

    await session.tick();
    const state = session.getState();

    expect(state.servers).toHaveLength(2);
    expect(state.fleets[0].unreachable).toEqual(['b']);
    expect(state.events.filter((e) => e.kind === 'server-unreachable')).toHaveLength(1);
  });

  it('reports an unreachable host once, not once per tick', async () => {
    const b = new StubObserver('b', serverSnapshot('b', [], { error: 'down' }));
    const session = new ObserveSession({ targets: [target(b)], intervalSeconds: 2 });

    await session.tick();
    await session.tick();
    await session.tick();

    expect(session.getState().events.filter((e) => e.kind === 'server-unreachable')).toHaveLength(1);
  });

  it('announces recovery when a host answers again', async () => {
    const healthySnapshot = serverSnapshot('b', [appSnapshot('api')]);
    const b = new StubObserver('b', healthySnapshot).queueUp(serverSnapshot('b', [], { error: 'down' }));
    const session = new ObserveSession({ targets: [target(b)], intervalSeconds: 2 });

    await session.tick();
    await session.tick();

    expect(session.getState().events.map((e) => e.kind)).toEqual(['server-unreachable', 'server-recovered']);
  });

  it('raises a health alert on the threshold crossing only', async () => {
    const down = serverSnapshot('a', [appSnapshot('api', { health: failing })]);
    const a = new StubObserver('a', down);
    const session = new ObserveSession({ targets: [target(a)], intervalSeconds: 2 });

    for (let i = 0; i < HEALTH_ALERT_THRESHOLD + 2; i += 1) await session.tick();

    const alerts = session.getState().events.filter((e) => e.kind === 'health-failing');
    expect(alerts).toHaveLength(1);
    expect(session.healthFailStreak('a', 'api')).toBe(HEALTH_ALERT_THRESHOLD + 2);
  });

  it('announces health recovery after an alert', async () => {
    const up = serverSnapshot('a', [appSnapshot('api', { health: healthy })]);
    const down = serverSnapshot('a', [appSnapshot('api', { health: failing })]);
    const a = new StubObserver('a', up).queueUp(down, down, down);
    const session = new ObserveSession({ targets: [target(a)], intervalSeconds: 2 });

    for (let i = 0; i < 4; i += 1) await session.tick();

    expect(session.getState().events.map((e) => e.kind)).toEqual(['health-failing', 'health-recovered']);
    expect(session.healthFailStreak('a', 'api')).toBe(0);
  });

  it('tracks health streaks per app, not per server', async () => {
    const a = new StubObserver(
      'a',
      serverSnapshot('a', [
        appSnapshot('api', { health: failing }),
        appSnapshot('web', { health: healthy }),
      ]),
    );
    const session = new ObserveSession({ targets: [target(a, ['api', 'web'])], intervalSeconds: 2 });

    for (let i = 0; i < HEALTH_ALERT_THRESHOLD; i += 1) await session.tick();

    expect(session.healthFailStreak('a', 'api')).toBe(HEALTH_ALERT_THRESHOLD);
    expect(session.healthFailStreak('a', 'web')).toBe(0);
  });

  it('samples accessories on a slower cadence than the poll', async () => {
    const a = new StubObserver('a', serverSnapshot('a', [appSnapshot('api')]));
    const session = new ObserveSession({ targets: [target(a, ['api'], ['postgres'])], intervalSeconds: 2 });

    // 10s cadence over a 2s interval means one sample every fifth tick.
    for (let i = 0; i < 6; i += 1) await session.tick();

    const sampled = a.requests.filter((r) => r.accessoryNames !== undefined);
    expect(sampled).toHaveLength(2);
    expect(a.requests[0].accessoryNames).toEqual(['postgres']);
    expect(a.requests[1].accessoryNames).toBeUndefined();
  });

  it('carries the last accessory reading through ticks that skipped it', async () => {
    const withAccessories = serverSnapshot('a', [appSnapshot('api')], {
      accessories: [{ name: 'postgres', status: 'running', health: 'healthy', image: 'postgres:16' }],
    });
    const a = new StubObserver('a', serverSnapshot('a', [appSnapshot('api')])).queueUp(withAccessories);
    const session = new ObserveSession({ targets: [target(a, ['api'], ['postgres'])], intervalSeconds: 2 });

    await session.tick();
    await session.tick();

    expect(session.getState().servers[0].accessories).toHaveLength(1);
  });

  it('skips a tick that arrives while the previous one is still running', async () => {
    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = new StubObserver('a', serverSnapshot('a', [appSnapshot('api')]), () => blocked);
    const session = new ObserveSession({ targets: [target(a)], intervalSeconds: 2 });

    const first = session.tick();
    await session.tick();
    release();
    await first;

    expect(a.requests).toHaveLength(1);
  });

  it('caps how many servers are polled at once', async () => {
    let live = 0;
    let peak = 0;
    const observers = Array.from({ length: MAX_CONCURRENT_POLLS + 3 }, (_, i) => {
      const name = `s${i}`;
      return new StubObserver(name, serverSnapshot(name, [appSnapshot('api')]), async () => {
        live += 1;
        peak = Math.max(peak, live);
        await Promise.resolve();
        live -= 1;
      });
    });
    const session = new ObserveSession({ targets: observers.map((o) => target(o)), intervalSeconds: 2 });

    await session.tick();

    expect(peak).toBe(MAX_CONCURRENT_POLLS);
    expect(observers.every((o) => o.requests.length === 1)).toBe(true);
  });

  it('records history per server and app', async () => {
    const a = new StubObserver(
      'a',
      serverSnapshot('a', [
        appSnapshot('api', {
          processes: [
            { name: 'api', pm2Name: 'api', pid: 1, status: 'online', cpu: 10, memory: 100, uptime: 0, restarts: 0, execMode: 'fork', instances: 1, unstableRestarts: 0, exitCode: null },
          ],
          health: healthy,
        }),
      ]),
    );
    const session = new ObserveSession({ targets: [target(a)], intervalSeconds: 2 });

    await session.tick();
    await session.tick();

    expect(session.history('a', 'api').cpu).toEqual([10, 10]);
    expect(session.history('a', 'api').responseMs).toEqual([10, 10]);
    expect(session.history('a', 'other').cpu).toEqual([]);
  });

  it('notifies subscribers and stops on unsubscribe', async () => {
    const a = new StubObserver('a', serverSnapshot('a', [appSnapshot('api')]));
    const session = new ObserveSession({ targets: [target(a)], intervalSeconds: 2 });
    const seen: number[] = [];
    const unsubscribe = session.subscribe((state) => seen.push(state.servers.length));

    await session.tick();
    expect(seen.length).toBeGreaterThan(0);

    unsubscribe();
    const before = seen.length;
    await session.tick();
    expect(seen).toHaveLength(before);
  });

  it('bounds the event log', async () => {
    const a = new StubObserver('a', serverSnapshot('a', [appSnapshot('api', { error: 'PM2 command failed' })]));
    const session = new ObserveSession({ targets: [target(a)], intervalSeconds: 2, maxEvents: 5 });

    for (let i = 0; i < 12; i += 1) await session.tick();

    expect(session.getState().events).toHaveLength(5);
  });
});

describe('ObserveSession scheduling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('polls immediately on start and then on the interval', async () => {
    const a = new StubObserver('a', serverSnapshot('a', [appSnapshot('api')]));
    const session = new ObserveSession({ targets: [target(a)], intervalSeconds: 2 });

    session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(4000);
    expect(a.requests).toHaveLength(3);

    session.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(a.requests).toHaveLength(3);
  });
});

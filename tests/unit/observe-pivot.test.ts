import { describe, it, expect } from 'vitest';
import { pivotByApp } from '../../src/domain/observe/pivot.js';
import type { AppSnapshot, ServerSnapshot } from '../../src/domain/observe/snapshot.js';
import type { SystemInfo } from '../../src/domain/observe/types.js';

const system: SystemInfo = {
  load1: 0.5, load5: 0.4, load15: 0.3, cores: 2,
  totalMem: 2048, usedMem: 1024, totalDisk: 40, usedDisk: 10, uptime: 100,
};

function app(name: string, release: string | null, extra: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    app: name,
    appType: 'backend',
    processes: [],
    currentRelease: release === null ? null : `/srv/${name}/releases/${release}`,
    releases: [],
    ...extra,
  };
}

function server(name: string, apps: AppSnapshot[], extra: Partial<ServerSnapshot> = {}): ServerSnapshot {
  return {
    server: name,
    timestamp: '2026-08-30T00:00:00.000Z',
    system,
    deployLock: null,
    apps,
    ...extra,
  };
}

describe('pivotByApp', () => {
  it('returns nothing for no snapshots', () => {
    expect(pivotByApp([])).toEqual([]);
  });

  it('groups one app across its replicas', () => {
    const views = pivotByApp([
      server('a.example.com', [app('api', '20260830010101')]),
      server('b.example.com', [app('api', '20260830010101')]),
    ]);

    expect(views).toHaveLength(1);
    expect(views[0].app).toBe('api');
    expect(views[0].replicas.map((r) => r.server)).toEqual(['a.example.com', 'b.example.com']);
    expect(views[0].convergence.converged).toBe(true);
    expect(views[0].convergence.releases).toEqual(['20260830010101']);
  });

  it('compares the release directory name, not the absolute symlink', () => {
    const views = pivotByApp([
      server('a', [{ ...app('api', null), currentRelease: '/srv/api/releases/2026' }]),
      server('b', [{ ...app('api', null), currentRelease: '/opt/other/api/releases/2026' }]),
    ]);
    expect(views[0].convergence.converged).toBe(true);
  });

  it('reports skew when replicas hold different releases', () => {
    const views = pivotByApp([
      server('a', [app('api', '20260830010101')]),
      server('b', [app('api', '20260829090909')]),
    ]);

    expect(views[0].convergence.converged).toBe(false);
    expect(views[0].convergence.releases).toHaveLength(2);
  });

  it('separates distinct apps and preserves per-server order', () => {
    const views = pivotByApp([
      server('a', [app('api', '1'), app('web', '1')]),
      server('b', [app('api', '1')]),
    ]);

    expect(views.map((v) => v.app)).toEqual(['api', 'web']);
    expect(views[0].replicas).toHaveLength(2);
    expect(views[1].replicas).toHaveLength(1);
  });

  it('names an unreachable server instead of counting it as converged', () => {
    const views = pivotByApp([
      server('a', [app('api', '20260830010101')]),
      server('b', [], { error: 'connect ETIMEDOUT', apps: [] }),
    ]);

    expect(views[0].unreachable).toEqual(['b']);
    expect(views[0].convergence.releases).toEqual(['20260830010101']);
  });

  it('carries an unreachable replica through only when the app is known to run there', () => {
    // A server that failed reports no apps, so it can only be attributed to an
    // app another replica proves exists.
    const views = pivotByApp([server('b', [], { error: 'down' })]);
    expect(views).toEqual([]);
  });

  it('blames a failed server only on the apps planned for it', () => {
    // `web` runs on a alone; `api` runs on a and b. b failing says nothing
    // about `web`, which must not turn into a fleet with a missing replica.
    const views = pivotByApp([
      server('a', [app('web', '1'), app('api', '1')]),
      server('b', [], { error: 'down', plannedApps: [{ app: 'api', appType: 'backend' }] }),
    ]);

    expect(views.find((v) => v.app === 'web')?.unreachable).toEqual([]);
    expect(views.find((v) => v.app === 'api')?.unreachable).toEqual(['b']);
  });

  it('ignores a failed server that only hosts accessories', () => {
    const views = pivotByApp([
      server('a', [app('api', '1')]),
      server('data', [], { error: 'down', plannedApps: [] }),
    ]);

    expect(views[0].unreachable).toEqual([]);
  });

  it('still shows an app whose every server failed', () => {
    const views = pivotByApp([
      server('a', [app('web', '1')]),
      server('b', [], { error: 'down', plannedApps: [{ app: 'site', appType: 'frontend' }] }),
      server('c', [], { error: 'down', plannedApps: [{ app: 'site', appType: 'frontend' }] }),
    ]);

    const site = views.find((v) => v.app === 'site');
    expect(site).toBeDefined();
    expect(site?.replicas).toEqual([]);
    expect(site?.unreachable).toEqual(['b', 'c']);
    expect(site?.appType).toBe('frontend');
  });

  it('lists reachable replicas and unreachable servers of the same app together', () => {
    const views = pivotByApp([
      server('a', [app('api', '1')]),
      server('b', [], { error: 'down', plannedApps: [{ app: 'api', appType: 'backend' }] }),
    ]);

    expect(views).toHaveLength(1);
    expect(views[0].replicas.map((r) => r.server)).toEqual(['a']);
    expect(views[0].unreachable).toEqual(['b']);
  });

  it('keeps a per-app error visible on the replica', () => {
    const views = pivotByApp([
      server('a', [app('api', '1', { error: 'PM2 command failed' })]),
    ]);
    expect(views[0].replicas[0].snapshot.error).toBe('PM2 command failed');
    expect(views[0].replicas[0].reachable).toBe(true);
  });

  it('treats a replica with no release as undeployed', () => {
    const views = pivotByApp([
      server('a', [app('api', '1')]),
      server('b', [app('api', null)]),
    ]);
    expect(views[0].convergence.undeployed).toEqual(['b']);
    expect(views[0].convergence.converged).toBe(false);
  });
});

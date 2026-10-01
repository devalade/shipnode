import { describe, it, expect } from 'vitest';
import { assembleConfig } from '../../src/config/assembly.js';
import { observeStateJson, planObserveHosts } from '../../src/cli/observe.js';

const fleet = assembleConfig({
  servers: {
    a: { host: '1.1.1.1', user: 'deploy', port: 22 },
    b: { host: '2.2.2.2', user: 'deploy', port: 22 },
    data: { host: '3.3.3.3', user: 'deploy', port: 22 },
  },
  remotePath: '/var/www/app',
  apps: [
    { name: 'api', appType: 'backend', on: ['a', 'b'], healthCheck: { enabled: true } },
    { name: 'web', appType: 'frontend', on: 'a', healthCheck: { enabled: false } },
  ],
  accessories: {
    postgres: { image: 'postgres:16', on: 'data' },
  },
});

describe('planObserveHosts', () => {
  it('groups apps and accessories by the servers they run on', () => {
    const plan = planObserveHosts(fleet);
    expect(plan.isOk()).toBe(true);
    if (!plan.isOk()) return;
    expect(plan.value.map((host) => host.name)).toEqual(['a', 'b', 'data']);
    expect(plan.value[0]?.apps.map((app) => app.name)).toEqual(['api', 'web']);
    expect(plan.value[1]?.apps.map((app) => app.name)).toEqual(['api']);
    expect(plan.value[2]?.accessoryNames).toEqual(['postgres']);
  });

  it('narrows to --on without dropping that server\'s other apps', () => {
    const plan = planObserveHosts(fleet, { on: 'a' });
    expect(plan.isOk()).toBe(true);
    if (!plan.isOk()) return;
    expect(plan.value.map((host) => host.name)).toEqual(['a']);
    expect(plan.value[0]?.apps.map((app) => app.name)).toEqual(['api', 'web']);
  });

  it('follows an app onto every replica it runs on', () => {
    const plan = planObserveHosts(fleet, { app: 'api' });
    expect(plan.isOk()).toBe(true);
    if (!plan.isOk()) return;
    expect(plan.value.map((host) => host.name)).toEqual(['a', 'b']);
    expect(plan.value.every((host) => host.apps.map((app) => app.name).join() === 'api')).toBe(true);
  });

  it('rejects an unknown app or server', () => {
    expect(planObserveHosts(fleet, { app: 'nope' }).isErr()).toBe(true);
    expect(planObserveHosts(fleet, { on: 'nope' }).isErr()).toBe(true);
  });
});

describe('observeStateJson', () => {
  it('emits servers and fleets from one tick', () => {
    const json = observeStateJson({
      servers: [],
      fleets: [],
      events: [],
      lastUpdate: '2026-09-18T00:00:00.000Z',
      polling: false,
    });
    expect(JSON.parse(json)).toEqual({
      servers: [],
      fleets: [],
      events: [],
      lastUpdate: '2026-09-18T00:00:00.000Z',
    });
  });
});

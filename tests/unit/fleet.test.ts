import { describe, expect, it } from 'vitest';
import { rollFleet, type FleetEvent, type ReplicaSession } from '../../src/domain/deploy/fleet.js';
import type { FakeRemoteExecutor } from '../testing/fake-executor.js';

interface Harness {
  /** Every deploy in the order it happened, as `server:action`. */
  timeline: string[];
  events: FleetEvent[];
  closed: string[];
  run: (overrides?: Partial<Parameters<typeof rollFleet>[0]>) => ReturnType<typeof rollFleet>;
}

function harness(options: { replicas?: string[]; failOn?: string } = {}): Harness {
  const replicas = options.replicas ?? ['web-a', 'web-b', 'web-c'];
  const timeline: string[] = [];
  const events: FleetEvent[] = [];
  const closed: string[] = [];

  const connect = async (serverName: string): Promise<ReplicaSession> => {
    const executor = {} as FakeRemoteExecutor;
    return { executor, close: () => closed.push(serverName) };
  };

  return {
    timeline,
    events,
    closed,
    run: (overrides = {}) => rollFleet({
      replicas,
      connect,
      applyToReplica: async ({ serverName }) => {
        timeline.push(`${serverName}:deploy`);
        if (serverName === options.failOn) throw new Error(`${serverName} failed to boot`);
      },
      onEvent: (event) => events.push(event),
      ...overrides,
    }),
  };
}

describe('rolling a fleet', () => {
  it('visits each replica in declaration order', async () => {
    const h = harness();

    const result = await h.run();

    expect(h.timeline).toEqual([
      'web-a:deploy', 'web-b:deploy', 'web-c:deploy',
    ]);
    expect(result.applied).toEqual(['web-a', 'web-b', 'web-c']);
    expect(result.failed).toBeUndefined();
  });

  it('hands every replica the same release id', async () => {
    // A per-replica timestamp makes a converged fleet indistinguishable from a
    // half-rolled one.
    const seen: (string | undefined)[] = [];
    const h = harness();

    const result = await h.run({
      releaseId: '2026-01-01T00-00-00-000Z',
      applyToReplica: async ({ releaseId }) => { seen.push(releaseId); },
    });

    expect(seen).toEqual(Array(3).fill('2026-01-01T00-00-00-000Z'));
    expect(result.releaseId).toBe('2026-01-01T00-00-00-000Z');
  });

  it('carries no release id for an operation that has none', async () => {
    // An instant blue-green rollback flips colours; there is no new release to
    // name, and inventing a timestamp would be a lie in the status output.
    const seen: (string | undefined)[] = [];
    const h = harness({ replicas: ['web-a'] });

    const result = await h.run({ applyToReplica: async ({ releaseId }) => { seen.push(releaseId); } });

    expect(seen).toEqual([undefined]);
    expect(result.releaseId).toBeUndefined();
  });

  it('marks exactly one replica first and one last, for the run-once hooks', async () => {
    const roles: string[] = [];
    const h = harness();

    await h.run({
      applyToReplica: async ({ serverName, role }) => {
        roles.push(`${serverName}:${role.first ? 'first' : ''}${role.last ? 'last' : ''}`);
      },
    });

    expect(roles).toEqual(['web-a:first', 'web-b:', 'web-c:last']);
  });

  it('never reaches the last replica when the roll fails, so afterFleet cannot run', async () => {
    const roles: { server: string; last: boolean }[] = [];
    const h = harness({ failOn: 'web-b' });

    await h.run({
      applyToReplica: async ({ serverName, role }) => {
        roles.push({ server: serverName, last: role.last });
        if (serverName === 'web-b') throw new Error('web-b failed to boot');
      },
    });

    expect(roles.some((entry) => entry.last)).toBe(false);
  });

  it('makes a sole replica both first and last', async () => {
    // Deploying one server — whether it is a single-server app or a fleet
    // narrowed with --on — must still run the run-once hooks exactly once.
    const roles: unknown[] = [];
    const h = harness({ replicas: ['web-a'] });

    await h.run({ applyToReplica: async ({ role }) => { roles.push(role); } });

    expect(roles).toEqual([{ first: true, last: true, primary: true }]);
  });

  it('keeps the primary fixed when a roll is narrowed to one replica', async () => {
    // `--on web-b` narrows the roll, but web-a is still the fleet's primary.
    // Promoting web-b would start a second copy of every placement:'primary'
    // process while web-a's is still running.
    const roles: { server: string; primary: boolean }[] = [];
    const h = harness({ replicas: ['web-b'] });

    await h.run({
      primary: 'web-a',
      applyToReplica: async ({ serverName, role }) => {
        roles.push({ server: serverName, primary: role.primary });
      },
    });

    expect(roles).toEqual([{ server: 'web-b', primary: false }]);
  });

  it('defaults the primary to the first replica of the roll', async () => {
    const primaries: string[] = [];
    const h = harness();

    await h.run({
      applyToReplica: async ({ serverName, role }) => {
        if (role.primary) primaries.push(serverName);
      },
    });

    expect(primaries).toEqual(['web-a']);
  });

  it('stops rolling at the first failure', async () => {
    const h = harness({ failOn: 'web-b' });

    const result = await h.run();

    expect(result.applied).toEqual(['web-a']);
    expect(result.failed).toEqual({ server: 'web-b', message: 'web-b failed to boot' });
    expect(result.skipped).toEqual(['web-c']);
    expect(h.timeline).not.toContain('web-c:deploy');
  });

  it('closes the connection of a replica that failed, and of every replica before it', async () => {
    const h = harness({ failOn: 'web-b' });

    await h.run();

    expect(h.closed).toEqual(['web-a', 'web-b']);
  });

  it('reports progress so a long roll is not silent', async () => {
    const h = harness({ replicas: ['web-a'] });

    await h.run();

    expect(h.events.map((event) => event.type)).toEqual([
      'applying', 'applied',
    ]);
  });
});

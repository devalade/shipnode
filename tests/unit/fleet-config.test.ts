import { describe, expect, it } from 'vitest';
import { app, shipnode } from '../../src/config/builder.js';
import { ShipnodeConfigSchema } from '../../src/config/schema.js';
import { expandTarget, getAppsForServer, resolveServerNames, resolveSingleServerNameResult } from '../../src/domain/servers.js';
import type { ShipnodeConfig } from '../../src/shared/types.js';

function fleetWorkspace(overrides: Record<string, unknown> = {}): unknown {
  return {
    servers: {
      'web-a': { host: '10.0.0.11', user: 'deploy', privateHost: '10.0.0.11' },
      'web-b': { host: '10.0.0.12', user: 'deploy', privateHost: '10.0.0.12' },
      'db-1': { host: '10.0.0.20', user: 'deploy', privateHost: '10.0.0.20' },
    },
    groups: { web: ['web-a', 'web-b'] },
    apps: [{
      name: 'api',
      appType: 'backend',
      on: 'web',
      domain: 'api.example.com',
      pm2: { apps: [{ name: 'api', port: 3333 }] },
    }],
    ...overrides,
  };
}

describe('fleet config', () => {
  it('expands a group into its members', () => {
    const config = ShipnodeConfigSchema.parse(fleetWorkspace()) as ShipnodeConfig;

    expect(resolveServerNames(config, config.apps[0].on)).toEqual(['web-a', 'web-b']);
  });

  it('accepts a list mixing servers and groups, deduped and in order', () => {
    const config = ShipnodeConfigSchema.parse(fleetWorkspace()) as ShipnodeConfig;

    expect(expandTarget(config, ['db-1', 'web'])).toEqual(['db-1', 'web-a', 'web-b']);
    expect(expandTarget(config, ['web', 'web-a'])).toEqual(['web-a', 'web-b']);
  });

  it('reports a fleet app under each of its replicas', () => {
    // getAppsForServer used to partition apps across servers. A replicated app
    // has to show up on every server it runs on, or deploy skips replicas.
    const config = ShipnodeConfigSchema.parse(fleetWorkspace()) as ShipnodeConfig;

    expect(getAppsForServer(config, 'web-a').map((a) => a.name)).toEqual(['api']);
    expect(getAppsForServer(config, 'web-b').map((a) => a.name)).toEqual(['api']);
    expect(getAppsForServer(config, 'db-1')).toEqual([]);
  });

  it('fills in rolling defaults for an app on more than one server', () => {
    const config = ShipnodeConfigSchema.parse(fleetWorkspace()) as ShipnodeConfig;

    expect(config.apps[0].fleet).toEqual({
      batch: 1,
      port: 80,
      drainWait: 30,
      readyPath: '/_shipnode/ready',
    });
  });

  it('leaves a single-server app alone', () => {
    const config = ShipnodeConfigSchema.parse(
      fleetWorkspace({ groups: undefined, apps: [{ name: 'api', appType: 'backend', on: 'web-a' }] }),
    ) as ShipnodeConfig;

    expect(config.apps[0].fleet).toBeUndefined();
  });

  it('honours an explicit fleet block on a single-server app', () => {
    const config = ShipnodeConfigSchema.parse(
      fleetWorkspace({
        groups: undefined,
        apps: [{ name: 'api', appType: 'backend', on: 'web-a', fleet: { drainWait: 5 } }],
      }),
    ) as ShipnodeConfig;

    expect(config.apps[0].fleet).toMatchObject({ drainWait: 5, batch: 1, port: 80 });
  });

  it('refuses a fleet whose servers cannot be reached privately', () => {
    // The load balancer talks to each replica directly; the public SSH host is
    // not necessarily that address.
    const result = ShipnodeConfigSchema.safeParse(fleetWorkspace({
      servers: {
        'web-a': { host: '10.0.0.11', user: 'deploy', privateHost: '10.0.0.11' },
        'web-b': { host: '10.0.0.12', user: 'deploy' },
      },
      groups: { web: ['web-a', 'web-b'] },
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('Add privateHost to: web-b');
    }
  });

  it('rejects a group named after a server', () => {
    const result = ShipnodeConfigSchema.safeParse(fleetWorkspace({
      groups: { 'db-1': ['web-a'] },
      apps: [{ name: 'api', appType: 'backend', on: 'web-a' }],
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('collides with a server'))).toBe(true);
    }
  });

  it('rejects a group referencing an unknown server', () => {
    const result = ShipnodeConfigSchema.safeParse(fleetWorkspace({
      groups: { web: ['web-a', 'ghost'] },
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes("unknown server 'ghost'"))).toBe(true);
    }
  });

  it('refuses to replicate an accessory', () => {
    // shipnode does not replicate managed services — pointing Postgres at a
    // group would start two unrelated databases, not a cluster.
    const result = ShipnodeConfigSchema.safeParse(fleetWorkspace({
      accessories: { postgres: { image: 'postgres:16', on: 'web' } },
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('exactly one server'))).toBe(true);
    }
  });

  it('names the servers when a single-server operation hits a fleet', () => {
    const config = ShipnodeConfigSchema.parse(fleetWorkspace()) as ShipnodeConfig;

    const result = resolveSingleServerNameResult(config, config.apps[0].on, "App 'api'");

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe('AmbiguousServerTargetError');
      expect(result.error.message).toContain('web-a, web-b');
      expect(result.error.message).toContain('--on');
    }
  });
});

describe('worker placement', () => {
  it('accepts placement on a worker', () => {
    const config = ShipnodeConfigSchema.parse(fleetWorkspace({
      apps: [{
        name: 'api',
        appType: 'backend',
        on: 'web',
        domain: 'api.example.com',
        pm2: { apps: [{ name: 'api', port: 3333 }, { name: 'cron', command: 'node cron.js', placement: 'primary' }] },
      }],
    })) as ShipnodeConfig;

    expect(config.apps[0].pm2?.apps[1]?.placement).toBe('primary');
  });

  it('rejects pinning the web process to one replica', () => {
    // The load balancer would keep routing to replicas running nothing.
    const parsed = ShipnodeConfigSchema.safeParse(fleetWorkspace({
      apps: [{
        name: 'api',
        appType: 'backend',
        on: 'web',
        domain: 'api.example.com',
        pm2: { apps: [{ name: 'api', port: 3333, placement: 'primary' }] },
      }],
    }));

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain('must run on every replica');
    }
  });
});

describe('fleet builder', () => {
  it('round-trips groups and fleet settings', () => {
    const config = shipnode
      .servers({
        'web-a': { host: '10.0.0.11', user: 'deploy', port: 22, privateHost: '10.0.0.11' },
        'web-b': { host: '10.0.0.12', user: 'deploy', port: 22, privateHost: '10.0.0.12' },
      })
      .group('web', ['web-a', 'web-b'])
      .deployTo('/var/www/app')
      .apps([
        app().backend().name('api').on('web').port(3333).domain('api.example.com').fleet({ batch: 2, drainWait: 10 }),
      ])
      .build();

    expect(config.groups).toEqual({ web: ['web-a', 'web-b'] });
    expect(config.apps[0].fleet).toMatchObject({ batch: 2, drainWait: 10, port: 80 });
    expect(resolveServerNames(config, config.apps[0].on)).toEqual(['web-a', 'web-b']);
  });
});

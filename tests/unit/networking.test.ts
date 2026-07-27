import { describe, expect, it } from 'vitest';
import { ShipnodeConfigSchema } from '../../src/config/schema.js';
import { accessoryHostVar, fleetFirewallRules, isLoopbackOnly } from '../../src/domain/networking.js';
import { ufwConfigureCommands } from '../../src/infrastructure/provisioning/security.js';
import type { ShipnodeConfig } from '../../src/shared/types.js';

function workspace(overrides: Record<string, unknown> = {}): unknown {
  return {
    servers: {
      'web-a': { host: '1.1.1.1', user: 'deploy', privateHost: '10.0.0.11' },
      'web-b': { host: '1.1.1.2', user: 'deploy', privateHost: '10.0.0.12' },
      'db-1': { host: '1.1.1.3', user: 'deploy', privateHost: '10.0.0.20' },
    },
    groups: { web: ['web-a', 'web-b'] },
    remotePath: '/var/www/app',
    accessories: {
      postgres: { image: 'postgres:16', on: 'db-1', port: '0.0.0.0:5432:5432' },
    },
    apps: [{
      name: 'api',
      appType: 'backend',
      on: 'web',
      domain: 'api.example.com',
      dependsOn: ['postgres'],
      pm2: { apps: [{ name: 'api', port: 3333 }] },
    }],
    ...overrides,
  };
}

const envOf = (config: ShipnodeConfig): Record<string, string> =>
  config.apps[0]!.pm2!.apps[0]!.env ?? {};

describe('accessoryHostVar', () => {
  it('uppercases and sanitises the accessory name', () => {
    expect(accessoryHostVar('postgres')).toBe('SHIPNODE_POSTGRES_HOST');
    expect(accessoryHostVar('my-cache.1')).toBe('SHIPNODE_MY_CACHE_1_HOST');
  });
});

describe('isLoopbackOnly', () => {
  it('is true only when every mapping pins a loopback bind', () => {
    expect(isLoopbackOnly({ image: 'r', port: '127.0.0.1:6379:6379' })).toBe(true);
    expect(isLoopbackOnly({ image: 'r', port: ['127.0.0.1:6379:6379', '[::1]:6380:6380'] })).toBe(true);
    expect(isLoopbackOnly({ image: 'r', port: ['127.0.0.1:6379:6379', '5432:5432'] })).toBe(false);
  });

  it('treats an unqualified mapping as reachable, because Docker binds it to every interface', () => {
    expect(isLoopbackOnly({ image: 'r', port: '5432:5432' })).toBe(false);
    expect(isLoopbackOnly({ image: 'r', port: '5432' })).toBe(false);
  });

  it('is false when nothing is published at all', () => {
    expect(isLoopbackOnly({ image: 'r' })).toBe(false);
  });
});

describe('fleetFirewallRules', () => {
  const parsed = (overrides: Record<string, unknown> = {}): ShipnodeConfig =>
    ShipnodeConfigSchema.parse(workspace(overrides)) as ShipnodeConfig;

  it('opens an accessory port only to the servers that depend on it', () => {
    // Not `ufw allow 5432/tcp` — a database reachable from the whole internet is
    // a worse outcome than one that is unreachable.
    const rules = fleetFirewallRules(parsed(), 'db-1');

    expect(rules).toEqual([
      { port: 5432, from: '10.0.0.11', comment: "postgres for db-1's dependants" },
      { port: 5432, from: '10.0.0.12', comment: "postgres for db-1's dependants" },
    ]);
  });

  it('opens nothing for an accessory whose only consumer is co-located', () => {
    const rules = fleetFirewallRules(parsed({
      accessories: { postgres: { image: 'postgres:16', on: 'web-a', port: '5432:5432' } },
      apps: [{
        name: 'api',
        appType: 'backend',
        on: 'web-a',
        dependsOn: ['postgres'],
        pm2: { apps: [{ name: 'api', port: 3333 }] },
      }],
    }), 'web-a');

    expect(rules).toEqual([]);
  });

  it('leaves the replica port alone when it is already an open port', () => {
    // The base rules allow 80 and 443; repeating them would be noise.
    expect(fleetFirewallRules(parsed(), 'web-a').filter((rule) => rule.from === undefined)).toEqual([]);
  });

  it('opens a non-standard replica port for the load balancer', () => {
    const rules = fleetFirewallRules(parsed({
      apps: [{
        name: 'api',
        appType: 'backend',
        on: 'web',
        domain: 'api.example.com',
        pm2: { apps: [{ name: 'api', port: 3333 }] },
        fleet: { port: 8080 },
      }],
    }), 'web-a');

    expect(rules).toContainEqual({
      port: 8080,
      comment: 'api replica port (load balancer ingress)',
    });
  });

  it('ignores a mapping with no host port to name', () => {
    const rules = fleetFirewallRules(parsed({
      accessories: { postgres: { image: 'postgres:16', on: 'db-1', port: '5432' } },
    }), 'db-1');

    expect(rules).toEqual([]);
  });
});

describe('ufwConfigureCommands', () => {
  it('adds the workspace rules before enabling, never after', () => {
    // Enabling first would leave the firewall briefly up with the holes closed.
    const commands = ufwConfigureCommands([{ port: 5432, from: '10.0.0.11', comment: 'postgres' }]);

    const allow = commands.findIndex((cmd) => cmd.includes('from 10.0.0.11 to any port 5432 proto tcp'));
    const enable = commands.findIndex((cmd) => cmd.includes('--force enable'));

    expect(allow).toBeGreaterThan(-1);
    expect(enable).toBeGreaterThan(allow);
  });

  it('is unchanged for a workspace with no extra rules', () => {
    expect(ufwConfigureCommands()).toHaveLength(6);
  });
});

describe('cross-server accessory addressing', () => {
  it('injects the accessory host into every process of the app', () => {
    const config = ShipnodeConfigSchema.parse(workspace()) as ShipnodeConfig;

    expect(envOf(config)).toMatchObject({ SHIPNODE_POSTGRES_HOST: '10.0.0.20' });
  });

  it('uses loopback when the accessory is on the same server as the app', () => {
    // The variable exists either way, so moving the database to its own box is
    // a config change and not a code change.
    const config = ShipnodeConfigSchema.parse(workspace({
      accessories: { postgres: { image: 'postgres:16', on: 'web-a', port: '5432:5432' } },
      apps: [{
        name: 'api',
        appType: 'backend',
        on: 'web-a',
        dependsOn: ['postgres'],
        pm2: { apps: [{ name: 'api', port: 3333 }] },
      }],
    })) as ShipnodeConfig;

    expect(envOf(config)).toMatchObject({ SHIPNODE_POSTGRES_HOST: '127.0.0.1' });
  });

  it('does not overwrite an address the user set explicitly', () => {
    const config = ShipnodeConfigSchema.parse(workspace({
      apps: [{
        name: 'api',
        appType: 'backend',
        on: 'web',
        domain: 'api.example.com',
        dependsOn: ['postgres'],
        pm2: { apps: [{ name: 'api', port: 3333, env: { SHIPNODE_POSTGRES_HOST: 'db.managed.example' } }] },
      }],
    })) as ShipnodeConfig;

    expect(envOf(config).SHIPNODE_POSTGRES_HOST).toBe('db.managed.example');
  });

  it('injects nothing when the accessory server has no private address', () => {
    const config = ShipnodeConfigSchema.parse(workspace({
      servers: {
        'web-a': { host: '1.1.1.1', user: 'deploy', privateHost: '10.0.0.11' },
        'web-b': { host: '1.1.1.2', user: 'deploy', privateHost: '10.0.0.12' },
        'db-1': { host: '1.1.1.3', user: 'deploy' },
      },
    })) as ShipnodeConfig;

    expect(envOf(config).SHIPNODE_POSTGRES_HOST).toBeUndefined();
  });

  it('rejects a cross-server accessory published only on loopback', () => {
    // No connection string can reach 127.0.0.1 on another machine, so this is
    // broken however the user configures the app.
    const parsed = ShipnodeConfigSchema.safeParse(workspace({
      accessories: { postgres: { image: 'postgres:16', on: 'db-1', port: '127.0.0.1:5432:5432' } },
    }));

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain('can never reach it across the network');
    }
  });

  it('allows a loopback bind when the app is on the same server', () => {
    const parsed = ShipnodeConfigSchema.safeParse(workspace({
      accessories: { postgres: { image: 'postgres:16', on: 'web-a', port: '127.0.0.1:5432:5432' } },
      apps: [{
        name: 'api',
        appType: 'backend',
        on: 'web-a',
        dependsOn: ['postgres'],
        pm2: { apps: [{ name: 'api', port: 3333 }] },
      }],
    }));

    expect(parsed.success).toBe(true);
  });
});

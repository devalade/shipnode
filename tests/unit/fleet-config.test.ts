import { describe, expect, it } from 'vitest';
import { app, shipnode } from '../../src/config/builder.js';
import { ShipnodeConfigSchema } from '../../src/config/schema.js';
import { expandTarget, getAppsForServer, isFleet, resolveServerNames, resolveSingleServerNameResult } from '../../src/domain/servers.js';
import type { ShipnodeConfig } from '../../src/shared/types.js';

function fleetWorkspace(overrides: Record<string, unknown> = {}): unknown {
  return {
    servers: { user: 'deploy', hosts: ['10.0.0.11', '10.0.0.12', '10.0.0.20'] },
    apps: [{
      name: 'api',
      appType: 'backend',
      on: ['10.0.0.11', '10.0.0.12'],
      domain: 'api.example.com',
      pm2: { apps: [{ name: 'api', port: 3333 }] },
    }],
    ...overrides,
  };
}

describe('servers input', () => {
  it('keys servers by host and applies the shared user', () => {
    const config = ShipnodeConfigSchema.parse({
      servers: { user: 'deploy', hosts: ['10.0.0.11', '10.0.0.12'] },
      apps: [{ name: 'api', appType: 'backend', on: '10.0.0.11' }],
    }) as ShipnodeConfig;

    expect(Object.keys(config.servers)).toEqual(['10.0.0.11', '10.0.0.12']);
    expect(config.servers['10.0.0.11']?.user).toBe('deploy');
    expect(config.servers['10.0.0.11']?.port).toBe(22);
  });

  it('defaults the user to root', () => {
    const config = ShipnodeConfigSchema.parse({
      servers: { hosts: ['10.0.0.11'] },
      apps: [{ name: 'api', appType: 'backend', on: '10.0.0.11' }],
    }) as ShipnodeConfig;

    expect(config.servers['10.0.0.11']?.user).toBe('root');
  });

  it('accepts user@host per-entry overrides', () => {
    const config = ShipnodeConfigSchema.parse({
      servers: { user: 'deploy', hosts: ['root@10.0.0.11', '10.0.0.12'] },
      apps: [{ name: 'api', appType: 'backend', on: '10.0.0.11' }],
    }) as ShipnodeConfig;

    expect(config.servers['10.0.0.11']?.user).toBe('root');
    expect(config.servers['10.0.0.12']?.user).toBe('deploy');
  });

  it('accepts a single host string', () => {
    const config = ShipnodeConfigSchema.parse({
      servers: { user: 'deploy', hosts: '10.0.0.11' },
      apps: [{ name: 'api', appType: 'backend', on: '10.0.0.11' }],
    }) as ShipnodeConfig;

    expect(resolveServerNames(config, undefined)).toEqual(['10.0.0.11']);
  });

  it('accepts per-host objects for non-default ports and identities', () => {
    const config = ShipnodeConfigSchema.parse({
      servers: {
        user: 'deploy',
        hosts: ['10.0.0.11', { host: 'example.com', port: 2222, identityFile: '~/.ssh/id_ed25519' }],
      },
      apps: [{ name: 'api', appType: 'backend', on: '10.0.0.11' }],
    }) as ShipnodeConfig;

    expect(config.servers['example.com']?.port).toBe(2222);
    expect(config.servers['example.com']?.identityFile).toBe('~/.ssh/id_ed25519');
    expect(config.servers['example.com']?.user).toBe('deploy');
  });

  it('applies every shared setting, not just the user, to each host', () => {
    const config = ShipnodeConfigSchema.parse({
      servers: {
        user: 'deploy',
        port: 2222,
        identityFile: '~/.ssh/id_ed25519',
        proxyMode: 'cloudflare',
        hosts: ['10.0.0.11', '10.0.0.12'],
      },
      apps: [{ name: 'api', appType: 'backend', on: '10.0.0.11' }],
    }) as ShipnodeConfig;

    for (const host of ['10.0.0.11', '10.0.0.12']) {
      expect(config.servers[host]).toMatchObject({
        host,
        user: 'deploy',
        port: 2222,
        identityFile: '~/.ssh/id_ed25519',
        proxyMode: 'cloudflare',
      });
    }
  });

  it('lets one host override a shared setting and keep the rest', () => {
    const config = ShipnodeConfigSchema.parse({
      servers: {
        user: 'deploy',
        port: 2222,
        identityFile: '~/.ssh/id_ed25519',
        hosts: ['10.0.0.11', { host: '10.0.0.12', port: 22 }],
      },
      apps: [{ name: 'api', appType: 'backend', on: '10.0.0.11' }],
    }) as ShipnodeConfig;

    expect(config.servers['10.0.0.12']?.port).toBe(22);
    // Overriding the port must not drop back to the schema defaults for the rest.
    expect(config.servers['10.0.0.12']?.user).toBe('deploy');
    expect(config.servers['10.0.0.12']?.identityFile).toBe('~/.ssh/id_ed25519');
    expect(config.servers['10.0.0.11']?.port).toBe(2222);
  });

  it('keeps a shared port under a user@host string', () => {
    const config = ShipnodeConfigSchema.parse({
      servers: { user: 'deploy', port: 2222, hosts: ['root@10.0.0.11'] },
      apps: [{ name: 'api', appType: 'backend', on: '10.0.0.11' }],
    }) as ShipnodeConfig;

    expect(config.servers['10.0.0.11']).toMatchObject({ user: 'root', port: 2222 });
  });

  it('falls back to the SSH defaults when nothing is shared or overridden', () => {
    const config = ShipnodeConfigSchema.parse({
      servers: { hosts: [{ host: '10.0.0.11', user: 'deploy' }] },
      apps: [{ name: 'api', appType: 'backend', on: '10.0.0.11' }],
    }) as ShipnodeConfig;

    expect(config.servers['10.0.0.11']?.port).toBe(22);
  });

  it('still accepts the legacy record form', () => {
    const config = ShipnodeConfigSchema.parse({
      servers: { 'web-a': { host: '10.0.0.11', user: 'deploy', port: 22 } },
      apps: [{ name: 'api', appType: 'backend', on: 'web-a' }],
    }) as ShipnodeConfig;

    expect(config.servers['web-a']?.host).toBe('10.0.0.11');
  });

  it('keys a workspace declared only with .ssh() by its host', () => {
    const config = ShipnodeConfigSchema.parse({
      ssh: { host: '10.0.0.11', user: 'deploy', port: 22 },
      apps: [{ name: 'api', appType: 'backend' }],
    }) as ShipnodeConfig;

    expect(Object.keys(config.servers)).toEqual(['10.0.0.11']);
    // A sole server needs no target.
    expect(resolveServerNames(config, undefined)).toEqual(['10.0.0.11']);
  });
});

describe('fleet config', () => {
  it('treats an app on more than one host as a fleet', () => {
    const config = ShipnodeConfigSchema.parse(fleetWorkspace()) as ShipnodeConfig;

    expect(isFleet(config, config.apps[0]!)).toBe(true);
    expect(resolveServerNames(config, config.apps[0].on)).toEqual(['10.0.0.11', '10.0.0.12']);
  });

  it('expands a list of hosts, deduped and in order', () => {
    const config = ShipnodeConfigSchema.parse(fleetWorkspace()) as ShipnodeConfig;

    expect(expandTarget(config, ['10.0.0.20', '10.0.0.11', '10.0.0.11'])).toEqual(['10.0.0.20', '10.0.0.11']);
  });

  it('reports a fleet app under each of its replicas', () => {
    // getAppsForServer used to partition apps across servers. A replicated app
    // has to show up on every server it runs on, or deploy skips replicas.
    const config = ShipnodeConfigSchema.parse(fleetWorkspace()) as ShipnodeConfig;

    expect(getAppsForServer(config, '10.0.0.11').map((a) => a.name)).toEqual(['api']);
    expect(getAppsForServer(config, '10.0.0.12').map((a) => a.name)).toEqual(['api']);
    expect(getAppsForServer(config, '10.0.0.20')).toEqual([]);
  });

  it('auto-enables blue-green for a fleet backend with a web port', () => {
    const config = ShipnodeConfigSchema.parse(fleetWorkspace()) as ShipnodeConfig;

    expect(config.apps[0].zeroDowntime).toBe(true);
  });

  it('auto-enables blue-green for a fleet backend without a domain', () => {
    // The replica serves the load balancer directly; the health-gated colour
    // flip does not need a domain.
    const config = ShipnodeConfigSchema.parse(fleetWorkspace({
      apps: [{
        name: 'api',
        appType: 'backend',
        on: ['10.0.0.11', '10.0.0.12'],
        pm2: { apps: [{ name: 'api', port: 3333 }] },
      }],
    })) as ShipnodeConfig;

    expect(config.apps[0].zeroDowntime).toBe(true);
  });

  it('keeps an explicit noZeroDowntime on a fleet', () => {
    const config = ShipnodeConfigSchema.parse(fleetWorkspace({
      apps: [{
        name: 'api',
        appType: 'backend',
        on: ['10.0.0.11', '10.0.0.12'],
        domain: 'api.example.com',
        zeroDowntime: false,
        pm2: { apps: [{ name: 'api', port: 3333 }] },
      }],
    })) as ShipnodeConfig;

    expect(config.apps[0].zeroDowntime).toBe(false);
  });

  it('honours the single-server default: blue-green needs a domain', () => {
    const config = ShipnodeConfigSchema.parse(fleetWorkspace({
      apps: [{ name: 'api', appType: 'backend', on: '10.0.0.11', pm2: { apps: [{ name: 'api', port: 3333 }] } }],
    })) as ShipnodeConfig;

    expect(config.apps[0].zeroDowntime).toBe(false);
  });

  it('leaves a single-server app alone', () => {
    const config = ShipnodeConfigSchema.parse(
      fleetWorkspace({ apps: [{ name: 'api', appType: 'backend', on: '10.0.0.11' }] }),
    ) as ShipnodeConfig;

    expect(isFleet(config, config.apps[0]!)).toBe(false);
  });

  it('rejects an unknown target', () => {
    const result = ShipnodeConfigSchema.safeParse(fleetWorkspace({
      apps: [{ name: 'api', appType: 'backend', on: 'ghost' }],
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes("Unknown server target 'ghost'"))).toBe(true);
    }
  });

  it('allows an accessory to name exactly one host', () => {
    // Managed services cannot be replicated — `on` is a single host, never a list.
    const result = ShipnodeConfigSchema.safeParse(fleetWorkspace({
      accessories: { postgres: { image: 'postgres:16', on: '10.0.0.20' } },
    }));

    expect(result.success).toBe(true);
  });

  it('rejects an accessory pointed at a list of hosts', () => {
    const result = ShipnodeConfigSchema.safeParse(fleetWorkspace({
      accessories: { postgres: { image: 'postgres:16', on: ['10.0.0.11', '10.0.0.12'] } },
    }));

    expect(result.success).toBe(false);
  });

  it('names the servers when a single-server operation hits a fleet', () => {
    const config = ShipnodeConfigSchema.parse(fleetWorkspace()) as ShipnodeConfig;

    const result = resolveSingleServerNameResult(config, config.apps[0].on, "App 'api'");

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe('AmbiguousServerTargetError');
      expect(result.error.message).toContain('10.0.0.11, 10.0.0.12');
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
        on: ['10.0.0.11', '10.0.0.12'],
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
        on: ['10.0.0.11', '10.0.0.12'],
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
  it('round-trips the servers object and fleet detection', () => {
    const config = shipnode
      .servers({ user: 'deploy', hosts: ['10.0.0.11', '10.0.0.12'] })
      .deployTo('/var/www/app')
      .apps([
        app().backend().name('api').on('10.0.0.11', '10.0.0.12').port(3333).domain('api.example.com'),
      ])
      .build();

    expect(Object.keys(config.servers)).toEqual(['10.0.0.11', '10.0.0.12']);
    expect(config.apps[0].zeroDowntime).toBe(true);
    expect(isFleet(config, config.apps[0]!)).toBe(true);
    expect(resolveServerNames(config, config.apps[0].on)).toEqual(['10.0.0.11', '10.0.0.12']);
  });

  it('carries shared connection settings through the builder, one host overriding', () => {
    const config = shipnode
      .servers({
        user: 'deploy',
        port: 2222,
        identityFile: '~/.ssh/id_ed25519',
        hosts: ['10.0.0.11', { host: '10.0.0.12', port: 22 }],
      })
      .deployTo('/var/www/app')
      .apps([app().backend().name('api').on('10.0.0.11', '10.0.0.12').port(3333)])
      .build();

    expect(config.servers['10.0.0.11']).toMatchObject({ user: 'deploy', port: 2222, identityFile: '~/.ssh/id_ed25519' });
    expect(config.servers['10.0.0.12']).toMatchObject({ user: 'deploy', port: 22, identityFile: '~/.ssh/id_ed25519' });
  });
});

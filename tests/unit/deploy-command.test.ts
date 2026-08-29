import { describe, expect, it, vi } from 'vitest';
import { cmdDeploy, printDryRun } from '../../src/cli/commands/deploy.js';
import type { ShipnodeConfig } from '../../src/shared/types.js';

vi.mock('../../src/config/loader.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../src/cli/ui.js', () => ({
  ui: {
    banner: vi.fn(),
    error: vi.fn(),
    note: vi.fn(),
  },
}));

const { ui } = await import('../../src/cli/ui.js');
const { loadConfig } = await import('../../src/config/loader.js');

describe('deploy command dry run', () => {
  const config: ShipnodeConfig = {
    ssh: { host: '1.1.1.1', user: 'deploy', port: 22 },
    servers: {
      app: { host: '1.1.1.1', user: 'deploy', port: 22 },
    },
    remotePath: '/var/www/app',
    nodeVersion: 'lts',
    apps: [{
      name: 'api',
      appType: 'backend',
      pm2: { apps: [{ name: 'api', port: 3000 }] },
      healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 3, startupDelay: 3 },
      envFile: '.env',
      keepReleases: 5,
      dependsOn: ['redis'],
    }],
    registry: {
      server: 'ghcr.io',
      username: 'acme',
      passwordEnv: 'REGISTRY_TOKEN',
    },
    accessories: {
      redis: {
        image: 'redis:7',
        on: 'app',
        port: '127.0.0.1:6379:6379',
        directories: ['redis-data:/data'],
        networks: ['shipnode-private'],
        command: 'redis-server --appendonly yes',
        labels: { 'com.shipnode.role': 'cache' },
        restart: 'always',
        resources: { memory: '512m', memoryReservation: '256m', cpus: '0.5' },
        stopTimeout: 20,
        healthCheck: { command: 'redis-cli ping' },
      },
    },
  };

  it('shows the resolved single server target instead of default', () => {
    printDryRun(config, false);

    expect(vi.mocked(ui.note).mock.calls[0]?.[0]).toContain('Server         app');
  });

  it('renders accessory plan details without secret values', () => {
    printDryRun(config, false);

    const output = vi.mocked(ui.note).mock.calls.at(-1)?.[0] ?? '';
    expect(output).toContain('Accessory: redis');
    expect(output).toContain('Server         app');
    expect(output).toContain('Image          redis:7');
    expect(output).toContain('Ports          127.0.0.1:6379:6379');
    expect(output).toContain('Volumes        redis-data:/data');
    expect(output).toContain('Networks       shipnode-private');
    expect(output).toContain('Command        redis-server --appendonly yes');
    expect(output).toContain('Labels         com.shipnode.role=cache');
    expect(output).toContain('Restart        always');
    expect(output).toContain('Resources      memory=512m, memoryReservation=256m, cpus=0.5');
    expect(output).toContain('Stop timeout   20s');
    expect(output).toContain('Registry       ghcr.io (REGISTRY_TOKEN)');
    expect(output).toContain('Login to ghcr.io using $REGISTRY_TOKEN');
    expect(output).toContain('Inspect/create named Docker volumes');
    expect(output).toContain('Inspect/create Docker networks');
    expect(output).toContain('Run health check');
    expect(output).not.toContain('acme-secret');
  });

  it('names the injected address when a dependency lives on a different server', () => {
    const redis = config.accessories?.redis;
    expect(redis).toBeDefined();
    if (!redis) return;

    printDryRun({
      ...config,
      servers: {
        app: { host: '1.2.3.4', user: 'deploy', port: 22 },
        data: { host: '2.3.4.5', user: 'deploy', port: 22 },
      },
      apps: config.apps.map((app) => ({ ...app, on: 'app' })),
      accessories: { redis: { ...redis, on: 'data' } },
    }, false);

    const output = vi.mocked(ui.note).mock.calls.at(-1)?.[0] ?? '';
    expect(output).toContain('Depends on     redis');
    expect(output).toContain('SHIPNODE_REDIS_HOST=2.3.4.5');
  });

  it('still warns when the config has been scoped to one app', () => {
    // --app narrows the config to that app and its servers, which drops the
    // server the accessory lives on. Resolving against the scoped config would
    // make the preview silent exactly when the dependency is cross-server.
    const redis = config.accessories?.redis;
    if (!redis) return;

    const workspace: ShipnodeConfig = {
      ...config,
      servers: {
        app: { host: '1.2.3.4', user: 'deploy', port: 22 },
        data: { host: '2.3.4.5', user: 'deploy', port: 22 },
      },
      apps: config.apps.map((a) => ({ ...a, on: 'app' })),
      accessories: { redis: { ...redis, on: 'data' } },
    };
    const scoped: ShipnodeConfig = {
      ...workspace,
      servers: { app: workspace.servers.app! },
      accessories: {},
    };

    printDryRun(scoped, false, workspace);

    expect(vi.mocked(ui.note).mock.calls.at(-1)?.[0] ?? '').toContain('SHIPNODE_REDIS_HOST=2.3.4.5');
  });

  it('tells the reader the variable the app is handed for a cross-server dependency', () => {
    // The preview is where a mis-scoped dependency shows up before it becomes a
    // runtime connection failure.
    const redis = config.accessories?.redis;
    if (!redis) return;

    printDryRun({
      ...config,
      servers: {
        app: { host: '1.2.3.4', user: 'deploy', port: 22 },
        data: { host: '2.3.4.5', user: 'deploy', port: 22 },
      },
      apps: config.apps.map((app) => ({ ...app, on: 'app' })),
      accessories: { redis: { ...redis, on: 'data' } },
    }, false);

    const output = vi.mocked(ui.note).mock.calls.at(-1)?.[0] ?? '';
    expect(output).toContain('SHIPNODE_REDIS_HOST=2.3.4.5 is set for api');
  });

  it('describes a fleet app once, with the roll and the replica site', () => {
    const fleetConfig: ShipnodeConfig = {
      ...config,
      servers: {
        'web-a': { host: '1.1.1.1', user: 'deploy', port: 22 },
        'web-b': { host: '1.1.1.2', user: 'deploy', port: 22 },
      },
      accessories: {},
      apps: config.apps.map((app) => ({
        ...app,
        on: ['web-a', 'web-b'],
        domain: 'api.example.com',
        dependsOn: undefined,
      })),
    };

    printDryRun(fleetConfig, false);
    const output = vi.mocked(ui.note).mock.calls.at(-1)?.[0] ?? '';

    // Once, not once per replica — the app appears under every server it runs on.
    expect(output.match(/App: api/g)).toHaveLength(1);
    expect(output).toContain('Servers        web-a, web-b');
    expect(output).toContain('Rolling        one replica at a time, blue-green per replica');
    expect(output).toContain('Roll replica 1 of 2');
    expect(output).toContain('Repeat for the next replica');

    // A replica answers to the domain so forwarded traffic reaches it, but over
    // plain HTTP — claiming it for TLS would make every replica race the others
    // for the same certificate.
    expect(output).toContain('http://:80, http://api.example.com:80 {');
    expect(output).not.toMatch(/(?<!http:\/\/)api\.example\.com \{/);
  });

  it('says where a pinned worker lands and where the run-once hooks fire', async () => {
    const fleetConfig: ShipnodeConfig = {
      ...config,
      servers: {
        'web-a': { host: '1.1.1.1', user: 'deploy', port: 22 },
        'web-b': { host: '1.1.1.2', user: 'deploy', port: 22 },
      },
      accessories: {},
      apps: config.apps.map((app) => ({
        ...app,
        on: ['web-a', 'web-b'],
        dependsOn: undefined,
        pm2: {
          apps: [
            { name: 'api', port: 3000 },
            { name: 'scheduler', command: 'node cron.js', placement: 'primary' as const },
          ],
        },
        hooks: {
          preDeploy: async () => {},
          beforeFleet: async () => {},
          afterFleet: async () => {},
        },
      })),
    };

    printDryRun(fleetConfig, false);
    const output = vi.mocked(ui.note).mock.calls.at(-1)?.[0] ?? '';

    expect(output).toContain('api-scheduler(web-a only)');
    expect(output).toContain('Run beforeFleet hook (first replica only)');
    expect(output).toContain('Run afterFleet hook (last replica only)');
    // afterFleet runs before cleanup, matching the orchestrator.
    expect(output.indexOf('afterFleet')).toBeLessThan(output.indexOf('Clean old releases'));
    // The footgun the hooks exist to solve, stated where someone will read it.
    expect(output).toContain('preDeploy runs once per replica — 2 times for this roll');
  });

  it('prints a clean error for an unknown dry-run app', async () => {
    vi.mocked(loadConfig).mockResolvedValue(config);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await cmdDeploy('/tmp/project', { dryRun: true, app: 'missing' });

    expect(ui.error).toHaveBeenCalledWith('No app named "missing" in this workspace');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });
});

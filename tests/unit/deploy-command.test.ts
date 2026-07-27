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
        data: { host: '2.3.4.5', user: 'deploy', port: 22, privateHost: '10.0.0.20' },
      },
      apps: config.apps.map((app) => ({ ...app, on: 'app' })),
      accessories: { redis: { ...redis, on: 'data' } },
    }, false);

    const output = vi.mocked(ui.note).mock.calls.at(-1)?.[0] ?? '';
    expect(output).toContain('Depends on     redis');
    expect(output).toContain('SHIPNODE_REDIS_HOST=10.0.0.20');
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
        data: { host: '2.3.4.5', user: 'deploy', port: 22, privateHost: '10.0.0.20' },
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

    expect(vi.mocked(ui.note).mock.calls.at(-1)?.[0] ?? '').toContain('SHIPNODE_REDIS_HOST=10.0.0.20');
  });

  it('says so when there is no private address to hand the app', () => {
    // localhost is the shipnode default and points at nothing from another box,
    // so silence here would mean a connection failure at runtime.
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
    expect(output).toContain('data has no privateHost');
  });

  it('describes a fleet app once, with the roll and the private site', () => {
    const fleetConfig: ShipnodeConfig = {
      ...config,
      servers: {
        'web-a': { host: '1.1.1.1', user: 'deploy', port: 22, privateHost: '10.0.0.11' },
        'web-b': { host: '1.1.1.2', user: 'deploy', port: 22, privateHost: '10.0.0.12' },
      },
      accessories: {},
      apps: config.apps.map((app) => ({
        ...app,
        on: ['web-a', 'web-b'],
        domain: 'api.example.com',
        dependsOn: undefined,
        fleet: { batch: 1, port: 80, drainWait: 20, readyPath: '/_shipnode/ready' },
      })),
    };

    printDryRun(fleetConfig, false);
    const output = vi.mocked(ui.note).mock.calls.at(-1)?.[0] ?? '';

    // Once, not once per replica — the app appears under every server it runs on.
    expect(output.match(/App: api/g)).toHaveLength(1);
    expect(output).toContain('Servers        web-a, web-b');
    expect(output).toContain('Rolling        1 at a time, 20s drain');
    expect(output).toContain('Drain one replica (/_shipnode/ready → 503)');
    expect(output).toContain('Wait 20s for the load balancer to notice');
    expect(output).toContain('Undrain (/_shipnode/ready → 200)');

    // A replica serves its private port; claiming the domain would make every
    // replica race the others for the same certificate.
    expect(output).toContain('http://10.0.0.11:80 {');
    expect(output).not.toContain('api.example.com {');
  });

  it('says where a pinned worker lands and where the run-once hooks fire', async () => {
    const fleetConfig: ShipnodeConfig = {
      ...config,
      servers: {
        'web-a': { host: '1.1.1.1', user: 'deploy', port: 22, privateHost: '10.0.0.11' },
        'web-b': { host: '1.1.1.2', user: 'deploy', port: 22, privateHost: '10.0.0.12' },
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
        fleet: { batch: 1, port: 80, drainWait: 20, readyPath: '/_shipnode/ready' },
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

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

  it('warns when an app dependency lives on a different server', () => {
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
      accessories: {
        redis: {
          ...redis,
          on: 'data',
        },
      },
    }, false);

    const output = vi.mocked(ui.note).mock.calls.at(-1)?.[0] ?? '';
    expect(output).toContain('Depends on     redis');
    expect(output).toContain('redis runs on data; api runs on app. Confirm reachable networking.');
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

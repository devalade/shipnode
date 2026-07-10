import { describe, expect, it } from 'vitest';
import { buildTasks } from '../../src/cli/commands/setup.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import type { ShipnodeConfig } from '../../src/shared/types.js';

function baseConfig(overrides: Partial<ShipnodeConfig>): ShipnodeConfig {
  return {
    ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
    servers: { default: { host: '1.2.3.4', user: 'deploy', port: 22 } },
    remotePath: '/var/www/app',
    nodeVersion: '24',
    apps: [],
    ...overrides,
  };
}

describe('setup target dependency selection', () => {
  it('installs Docker but not Node or Caddy for accessory-only targets', async () => {
    const executor = new FakeRemoteExecutor();
    const config = baseConfig({
      accessories: { redis: { image: 'redis:7' } },
    });

    await buildTasks(executor, config, null).run();

    const commands = executor.getHistory().map((entry) => entry.command).join('\n');
    expect(commands).toContain('docker-ce');
    expect(commands).not.toContain('mise install');
    expect(commands).not.toContain('caddy-stable');
  });

  it('installs app dependencies but not Docker for app-only targets', async () => {
    const executor = new FakeRemoteExecutor();
    const config = baseConfig({
      apps: [{
        name: 'api',
        appType: 'backend',
        domain: 'api.example.com',
        pm2: { apps: [{ name: 'api', port: 3000 }] },
        healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 3, startupDelay: 3 },
        envFile: '.env',
        keepReleases: 5,
      }],
    });

    await buildTasks(executor, config, null).run();

    const commands = executor.getHistory().map((entry) => entry.command).join('\n');
    expect(commands).toContain('mise install');
    expect(commands).toContain('pm2');
    expect(commands).toContain('caddy-stable');
    expect(commands).not.toContain('docker-ce');
  });
});

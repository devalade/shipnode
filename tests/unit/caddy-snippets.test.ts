import { describe, expect, it } from 'vitest';
import { CaddyService } from '../../src/services/caddy.service.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import type { ShipnodeApp, ShipnodeConfig } from '../../src/shared/types.js';

const baseApp: ShipnodeApp = {
  name: 'api',
  appType: 'backend',
  domain: 'api.example.com',
  pm2: { apps: [{ name: 'api', port: 3000 }] },
  healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 3, startupDelay: 3 },
  envFile: '.env',
  keepReleases: 5,
};

const config: ShipnodeConfig = {
  ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
  servers: { default: { host: '1.2.3.4', user: 'deploy', port: 22 } },
  remotePath: '/var/www/app',
  nodeVersion: 'lts',
  apps: [baseApp],
};

describe('CaddyService snippets', () => {
  it('keeps backend output unchanged without snippets', async () => {
    const executor = new FakeRemoteExecutor();
    const caddy = new CaddyService(executor, config);

    await caddy.configureBackend(baseApp);

    expect(executor.getLastCommand()?.command).toContain('$SUDO tee /etc/caddy/conf.d/api.caddy');
    expect(executor.getLastCommand()?.command).toContain(`api.example.com {
    reverse_proxy localhost:3000

    encode gzip

    log {
        output file /var/log/caddy/api.log
    }
}`);
  });

  it('reloads Caddy through sudo and propagates failures', async () => {
    const executor = new FakeRemoteExecutor().when(
      (command) => command.includes('systemctl reload caddy'),
      { stdout: '', stderr: 'reload failed', exitCode: 1 },
    );
    const caddy = new CaddyService(executor, config);

    await expect(caddy.reload()).rejects.toThrow('reload failed');

    expect(executor.getLastCommand()?.command).toContain('$SUDO systemctl reload caddy');
  });

  it('appends non-empty snippets inside the site block', async () => {
    const executor = new FakeRemoteExecutor();
    const caddy = new CaddyService(executor, config);

    await caddy.configureBackend({
      ...baseApp,
      caddy: { append: 'header X-Content-Type-Options "nosniff"' },
    });

    expect(executor.getLastCommand()?.command).toContain('header X-Content-Type-Options "nosniff"');
    expect(executor.getLastCommand()?.command).toContain(`    header X-Content-Type-Options "nosniff"
}`);
  });
});

describe('configureAll reloads what it writes', () => {
  const fleetApp: ShipnodeApp = {
    ...baseApp,
    domain: undefined,
    zeroDowntime: false,
    fleet: { batch: 1, port: 80, drainWait: 8, readyPath: '/_shipnode/ready' },
  };

  it('reloads Caddy after writing a fleet replica site', async () => {
    // The site file changes nothing until Caddy re-reads it. Only the blue-green
    // path reloaded, and a fleet replica has no domain so is never blue-green —
    // its readiness endpoint 404'd and the load balancer took it out of rotation.
    const executor = new FakeRemoteExecutor();
    const fleetConfig: ShipnodeConfig = {
      ...config,
      servers: { 'web-a': { host: '1.2.3.4', user: 'deploy', port: 22, privateHost: '10.0.0.11' } },
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22, privateHost: '10.0.0.11' },
      apps: [fleetApp],
    };

    await new CaddyService(executor, fleetConfig).configureAll();

    const commands = executor.getHistory().map((entry) => entry.command);
    const wrote = commands.findIndex((c) => c.includes('/etc/caddy/conf.d/api.caddy'));
    const reloaded = commands.findIndex((c) => c.includes('systemctl reload caddy'));

    expect(wrote).toBeGreaterThanOrEqual(0);
    expect(reloaded).toBeGreaterThan(wrote);
  });

  it('reloads once, not once per app', async () => {
    const executor = new FakeRemoteExecutor();
    const twoApps: ShipnodeConfig = {
      ...config,
      apps: [
        { ...baseApp, name: 'api', zeroDowntime: false },
        { ...baseApp, name: 'web', appType: 'frontend', pm2: undefined, domain: 'example.com' },
      ],
    };

    await new CaddyService(executor, twoApps).configureAll();

    const reloads = executor.getHistory()
      .filter((entry) => entry.command.includes('systemctl reload caddy'));
    expect(reloads).toHaveLength(1);
  });

  it('does not reload when there is nothing to write', async () => {
    const executor = new FakeRemoteExecutor();
    const noSites: ShipnodeConfig = {
      ...config,
      apps: [{ ...baseApp, domain: undefined, fleet: undefined }],
    };

    await new CaddyService(executor, noSites).configureAll();

    expect(executor.getHistory().some((e) => e.command.includes('reload caddy'))).toBe(false);
  });
});

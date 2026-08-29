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
  // A fleet replica: more than one host in `on`, no domain of its own — the
  // load balancer health-checks the replica directly.
  const fleetApp: ShipnodeApp = {
    ...baseApp,
    domain: undefined,
    zeroDowntime: false,
    on: ['1.2.3.4', '1.2.3.5'],
  };

  it('reloads Caddy after writing a fleet replica site', async () => {
    // The site file changes nothing until Caddy re-reads it. Only the blue-green
    // path reloaded, and a fleet replica has no domain so is never blue-green —
    // the first fleet deploy wrote a site file that never took effect.
    const executor = new FakeRemoteExecutor();
    const fleetConfig: ShipnodeConfig = {
      ...config,
      servers: {
        '1.2.3.4': { host: '1.2.3.4', user: 'deploy', port: 22 },
        '1.2.3.5': { host: '1.2.3.5', user: 'deploy', port: 22 },
      },
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      apps: [fleetApp],
    };

    await new CaddyService(executor, fleetConfig).configureAll();

    const commands = executor.getHistory().map((entry) => entry.command);
    const wrote = commands.findIndex((c) => c.includes('/etc/caddy/conf.d/api.caddy'));
    const reloaded = commands.findIndex((c) => c.includes('systemctl reload caddy'));

    expect(wrote).toBeGreaterThanOrEqual(0);
    expect(reloaded).toBeGreaterThan(wrote);
  });

  it('serves every interface on the fleet port and never claims the domain', async () => {
    // The LB's health check dials the replica directly and sends its own
    // address as the Host, which a host-bound site would not match on a NAT'd
    // cloud box; the domain is listed for the client traffic the LB forwards.
    const executor = new FakeRemoteExecutor();
    const domainApp: ShipnodeApp = { ...fleetApp, domain: 'api.example.com' };
    const fleetConfig: ShipnodeConfig = {
      ...config,
      servers: {
        '1.2.3.4': { host: '1.2.3.4', user: 'deploy', port: 22 },
        '1.2.3.5': { host: '1.2.3.5', user: 'deploy', port: 22 },
      },
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      apps: [domainApp],
    };

    await new CaddyService(executor, fleetConfig).configureBackend(domainApp);

    const site = executor.getHistory()
      .find((entry) => entry.command.includes('/etc/caddy/conf.d/api.caddy'))?.command ?? '';
    expect(site).toContain('http://:80');
    expect(site).toContain('http://api.example.com:80');
    expect(site).toContain('reverse_proxy localhost:3000');
    expect(site).not.toContain('https://');
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
      apps: [{ ...baseApp, domain: undefined, on: ['1.2.3.4'] }],
    };

    await new CaddyService(executor, noSites).configureAll();

    expect(executor.getHistory().some((e) => e.command.includes('reload caddy'))).toBe(false);
  });
});

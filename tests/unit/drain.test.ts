import { describe, expect, it } from 'vitest';
import { CaddyService, generateFleetCaddyfile } from '../../src/services/caddy.service.js';
import { drain, isDrained, undrain, drainSentinelPath } from '../../src/domain/deploy/drain.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import type { ShipnodeApp, ShipnodeConfig } from '../../src/shared/types.js';

const fleetApp: ShipnodeApp = {
  name: 'api',
  appType: 'backend',
  domain: 'api.example.com',
  pm2: { apps: [{ name: 'api', port: 3000 }] },
  healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 3, startupDelay: 3 },
  envFile: '.env',
  keepReleases: 5,
  zeroDowntime: false,
  blueGreenRetention: 'rollback',
  on: ['web-a', 'web-b'],
  fleet: { batch: 1, port: 80, drainWait: 30, readyPath: '/_shipnode/ready' },
};

const config: ShipnodeConfig = {
  ssh: { host: '1.2.3.4', user: 'deploy', port: 22, privateHost: '10.0.0.11' },
  servers: {
    'web-a': { host: '1.2.3.4', user: 'deploy', port: 22, privateHost: '10.0.0.11' },
    'web-b': { host: '1.2.3.5', user: 'deploy', port: 22, privateHost: '10.0.0.12' },
  },
  remotePath: '/var/www/app',
  nodeVersion: 'lts',
  apps: [fleetApp],
};

describe('fleet Caddy site', () => {
  it('answers to the domain over plain HTTP, never claiming it for TLS', async () => {
    // Two different Hosts arrive on this port: the load balancer's health check
    // dials the private address, while forwarded client traffic carries the
    // app's domain. Binding only the private address made the health check pass
    // while every real request fell through to whatever else held port 80.
    //
    // The `http://` scheme is what keeps this safe — a bare `api.example.com {`
    // would have every replica racing the others for one Let's Encrypt cert.
    const executor = new FakeRemoteExecutor();

    await new CaddyService(executor, config).configureBackend(fleetApp);

    const written = executor.getLastCommand()?.command ?? '';
    expect(written).toContain('http://10.0.0.11:80, http://api.example.com:80 {');
    expect(written).not.toContain('api.example.com {\n');
    expect(written).not.toMatch(/(?<!http:\/\/)api\.example\.com \{/);
  });

  it('serves a readiness endpoint gated on the drain sentinel', () => {
    const site = generateFleetCaddyfile(fleetApp, {
      listen: 80,
      bind: '10.0.0.11',
      upstream: 3000,
      readyPath: '/_shipnode/ready',
      stateDir: '/var/www/app/api/.shipnode',
    });

    expect(site).toContain('handle /_shipnode/ready {');
    expect(site).toContain('root /var/www/app/api/.shipnode');
    expect(site).toContain('try_files drain');
    expect(site).toContain('respond @draining "draining" 503');
    expect(site).toContain('respond "ready" 200');
    expect(site).toContain('reverse_proxy localhost:3000');
  });

  it('follows the blue-green colour on its upstream', async () => {
    // Rolling happens across replicas, blue-green within one. The fleet site
    // has to track the colour flip or traffic lands on the old process.
    const executor = new FakeRemoteExecutor();

    await new CaddyService(executor, config).configureBackend(fleetApp, 13000);

    expect(executor.getLastCommand()?.command).toContain('reverse_proxy localhost:13000');
  });

  it('binds every interface when the server has no private address', () => {
    const site = generateFleetCaddyfile(fleetApp, {
      listen: 8080,
      upstream: 3000,
      readyPath: '/ready',
      stateDir: '/state',
    });

    expect(site).toContain('http://:8080, http://api.example.com:8080 {');
  });

  it('binds only the private address when the app declares no domain', () => {
    const site = generateFleetCaddyfile({ ...fleetApp, domain: undefined }, {
      listen: 80,
      bind: '10.0.0.11',
      upstream: 3000,
      readyPath: '/ready',
      stateDir: '/state',
    });

    expect(site).toContain('http://10.0.0.11:80 {');
    expect(site).not.toContain(',');
  });

  it('serves static files for a frontend replica', async () => {
    const executor = new FakeRemoteExecutor();
    const frontend: ShipnodeApp = { ...fleetApp, appType: 'frontend', pm2: undefined };

    await new CaddyService(executor, { ...config, apps: [frontend] }).configureFrontend(frontend);

    const written = executor.getLastCommand()?.command ?? '';
    expect(written).toContain('root * /var/www/app/api/current');
    expect(written).toContain('handle /_shipnode/ready {');
    expect(written).not.toContain('api.example.com {');
  });

  it('leaves a non-fleet app on its public domain', async () => {
    const executor = new FakeRemoteExecutor();
    const solo: ShipnodeApp = { ...fleetApp, on: 'web-a', fleet: undefined };

    await new CaddyService(executor, config).configureBackend(solo);

    expect(executor.getLastCommand()?.command).toContain('api.example.com {');
  });
});

describe('drain sentinel', () => {
  it('round-trips drained state', async () => {
    const executor = new FakeRemoteExecutor();

    await drain(executor, '/var/www/app', 'api');
    expect(executor.getLastCommand()?.command).toContain('touch "/var/www/app/api/.shipnode/drain"');

    await undrain(executor, '/var/www/app', 'api');
    expect(executor.getLastCommand()?.command).toContain('rm -f "/var/www/app/api/.shipnode/drain"');
  });

  it('reports whether a replica is out of rotation', async () => {
    const drained = new FakeRemoteExecutor().when(() => true, { stdout: 'YES', stderr: '', exitCode: 0 });
    const serving = new FakeRemoteExecutor().when(() => true, { stdout: 'NO', stderr: '', exitCode: 0 });

    expect(await isDrained(drained, '/var/www/app', 'api')).toBe(true);
    expect(await isDrained(serving, '/var/www/app', 'api')).toBe(false);
  });

  it('puts the sentinel where the Caddy site looks for it', () => {
    // These two agree by construction or draining silently does nothing.
    const sentinel = drainSentinelPath('/var/www/app', 'api');
    const site = generateFleetCaddyfile(fleetApp, {
      listen: 80,
      upstream: 3000,
      readyPath: '/_shipnode/ready',
      stateDir: '/var/www/app/api/.shipnode',
    });

    const [dir, file] = [sentinel.slice(0, sentinel.lastIndexOf('/')), sentinel.slice(sentinel.lastIndexOf('/') + 1)];
    expect(site).toContain(`root ${dir}`);
    expect(site).toContain(`try_files ${file}`);
  });
});

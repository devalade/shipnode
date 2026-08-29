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

  it('creates deployment directories with the effective SSH user as owner', async () => {
    const executor = new FakeRemoteExecutor();
    const config = baseConfig({
      ssh: { host: '1.2.3.4', user: 'ubuntu', port: 22 },
      apps: [{
        name: 'worker',
        appType: 'backend',
        pm2: { apps: [{ name: 'worker', command: 'node worker.js' }] },
        healthCheck: { enabled: false, path: '/health', timeout: 30, retries: 3, startupDelay: 3 },
        envFile: '.env',
        keepReleases: 5,
        zeroDowntime: false,
      }],
    });

    await buildTasks(executor, config, null).run();

    const directories = executor.getHistory().find((entry) => entry.command.includes('install -d'))?.command;
    expect(directories).toContain("OWNER='ubuntu'");
    expect(directories).toContain('-o "$OWNER"');
    expect(directories).toContain("'/var/www/app/releases'");
  });

  it('installs and verifies the PM2 systemd unit, then saves as the deploy user', async () => {
    const executor = new FakeRemoteExecutor();
    const config = baseConfig({
      apps: [{
        name: 'api',
        appType: 'backend',
        pm2: { apps: [{ name: 'api', port: 3000 }] },
        healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 3, startupDelay: 3 },
        envFile: '.env',
        keepReleases: 5,
        zeroDowntime: false,
      }],
    });

    await buildTasks(executor, config, 'deploy').run();

    const startup = executor.getHistory().find((entry) => entry.command.includes('startup systemd'))?.command;
    expect(startup).toContain('sudo');
    expect(startup).toContain('pm2-deploy.service');
    expect(startup).toContain('systemctl is-enabled --quiet');
    expect(startup).toContain('sudo -u "deploy"');
    expect(startup).toContain('pm2 save --force');
    expect(startup).not.toContain('|| true');

    // sudo inherits the caller's working directory, and setup normally runs over
    // SSH as root whose home is mode 700. Node's spawn() returns EACCES from an
    // unreadable cwd, so every pm2 command that starts the daemon failed with a
    // message naming the node binary rather than the cause.
    expect(startup).toContain('sudo -u "deploy" -H');
    expect(startup).toContain('cd "$HOME"');
  });

  it('runs every deploy-user command from a directory that user can read', async () => {
    const executor = new FakeRemoteExecutor();
    const config = baseConfig({
      apps: [{
        name: 'api',
        appType: 'backend',
        pm2: { apps: [{ name: 'api', port: 3000 }] },
        healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 3, startupDelay: 3 },
        envFile: '.env',
        keepReleases: 5,
        zeroDowntime: false,
      }],
    });

    await buildTasks(executor, config, 'deploy').run();

    const asDeploy = executor.getHistory()
      .map((entry) => entry.command)
      .filter((command) => command.includes('sudo -u "deploy"'));

    expect(asDeploy.length).toBeGreaterThan(0);
    for (const command of asDeploy) {
      expect(command).toContain('sudo -u "deploy" -H');
      expect(command).toContain('cd "$HOME"');
    }
  });

  it('propagates a PM2 startup failure with its command output', async () => {
    const executor = new FakeRemoteExecutor().when(
      (command) => command.includes('startup systemd'),
      { stdout: '', stderr: 'systemd unit could not be enabled', exitCode: 1 },
    );
    const config = baseConfig({
      apps: [{
        name: 'api',
        appType: 'backend',
        pm2: { apps: [{ name: 'api', port: 3000 }] },
        healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 3, startupDelay: 3 },
        envFile: '.env',
        keepReleases: 5,
        zeroDowntime: false,
      }],
    });

    await expect(buildTasks(executor, config, 'deploy').run()).rejects.toThrow('systemd unit could not be enabled');
  });

  it('installs Caddy for a fleet replica, which has no domain', async () => {
    // A fleet replica deliberately has no domain — replicas claiming one name
    // would race Let's Encrypt — but it still needs Caddy to serve the app for
    // the load balancer, which health-checks the replica directly.
    const executor = new FakeRemoteExecutor();
    const config = baseConfig({
      servers: {
        '1.2.3.4': { host: '1.2.3.4', user: 'deploy', port: 22 },
        '1.2.3.5': { host: '1.2.3.5', user: 'deploy', port: 22 },
      },
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      apps: [{
        name: 'api',
        appType: 'backend',
        on: ['1.2.3.4', '1.2.3.5'],
        pm2: { apps: [{ name: 'api', port: 3000 }] },
        healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 3, startupDelay: 3 },
        envFile: '.env',
        keepReleases: 5,
        zeroDowntime: false,
      }],
    });

    await buildTasks(executor, config, 'deploy').run();

    const commands = executor.getHistory().map((entry) => entry.command);
    expect(commands.some((c) => c.includes('apt-get install -y caddy'))).toBe(true);
    // Without this directory the first deploy dies writing its site file.
    expect(commands.some((c) => c.includes('mkdir -p /etc/caddy/conf.d'))).toBe(true);
  });
});

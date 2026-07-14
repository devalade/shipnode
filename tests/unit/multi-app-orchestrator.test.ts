import { describe, it, expect, vi } from 'vitest';
import { DeployOrchestrator } from '../../src/domain/deploy/orchestrator.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import { assembleConfig } from '../../src/config/assembly.js';

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
}));

vi.mock('fs-extra', () => ({
  pathExists: vi.fn().mockResolvedValue(false),
}));

describe('DeployOrchestrator — multi-app', () => {
  it('deploys a backend app and a frontend app under the same workspace', async () => {
    const executor = new FakeRemoteExecutor();

    executor
      // mkdir per app
      .when((cmd) => cmd.includes('mkdir -p') && cmd.includes('/api/'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('mkdir -p') && cmd.includes('/web/'), { stdout: '', exitCode: 0 })
      // symlink
      .when((cmd) => cmd.includes('ln -sfn'), { stdout: '', exitCode: 0 })
      // mv
      .when((cmd) => cmd.includes('mv -Tf'), { stdout: '', exitCode: 0 })
      // releases.json read
      .when((cmd) => cmd.includes('cat') && cmd.includes('releases.json'), { stdout: '[]', exitCode: 0 })
      // releases.json write
      .when((cmd) => cmd.includes('releases.json') && cmd.includes('base64'), { stdout: '', exitCode: 0 })
      // ls
      .when((cmd) => cmd.includes('ls -1t'), { stdout: '', exitCode: 0 })
      // lock
      .when((cmd) => cmd.includes('deploy.lock'), { stdout: 'OK', exitCode: 0 })
      // health check on the backend
      .when((cmd) => cmd.includes('curl') && cmd.includes('localhost:13000'), { stdout: '200 42', exitCode: 0 })
      // pm2 jlist — both apps must be online
      .when((cmd) => cmd.includes('pm2 jlist'), {
        stdout: JSON.stringify([
          { name: 'api-green', pm2_env: { status: 'online', restart_time: 0 } },
        ]),
        exitCode: 0,
      });

    const config = assembleConfig({
      apps: [
        {
          name: 'api',
          appType: 'backend',
          domain: 'api.example.com',
          pm2: { apps: [{ name: 'api', port: 3000 }] },
          healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 3, startupDelay: 0 },
          envFile: '.env.api',
          keepReleases: 5,
        },
        {
          name: 'web',
          appType: 'frontend',
          domain: 'www.example.com',
          keepReleases: 3,
        },
      ],
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      remotePath: '/var/www/app',
    });

    const { DeployLock } = await import('../../src/domain/release/manager.js');
    const { HealthCheckService } = await import('../../src/services/health.service.js');
    const { CaddyService } = await import('../../src/services/caddy.service.js');

    const orchestrator = new DeployOrchestrator(
      config,
      executor,
      new DeployLock(executor, config.remotePath),
      new HealthCheckService(executor, config),
      new CaddyService(executor, config),
    );

    await orchestrator.deploy({ cwd: '/test', skipBuild: false });

    const history = executor.getHistory();

    // Lock was acquired
    const lockAcquire = history.find((h) => h.command.includes('deploy.lock'));
    expect(lockAcquire).toBeDefined();

    // Lock was released
    const lockRelease = history.filter((h) => h.command.includes('rm -rf') && h.command.includes('deploy.lock'));
    expect(lockRelease.length).toBeGreaterThan(0);

    // Backend release dir was created
    const apiMkdir = history.filter((h) => h.command.includes('mkdir -p') && h.command.includes('/api/'));
    expect(apiMkdir.length).toBeGreaterThan(0);

    // Frontend release dir was created
    const webMkdir = history.filter((h) => h.command.includes('mkdir -p') && h.command.includes('/web/'));
    expect(webMkdir.length).toBeGreaterThan(0);

    // Health check ran for the backend (frontend has none)
    const health = history.filter((h) => h.command.includes('curl') && h.command.includes('localhost:13000'));
    expect(health.length).toBeGreaterThan(0);
  });
});

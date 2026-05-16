import { describe, it, expect, vi } from 'vitest';
import { DeployOrchestrator } from '../../src/domain/deploy/orchestrator.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import type { DeploymentStrategy, StrategyContext } from '../../src/domain/deploy/strategy.js';
import type { ShipnodeConfig } from '../../src/shared/types.js';

function makeConfig(overrides: Partial<ShipnodeConfig> = {}): ShipnodeConfig {
  return {
    app: 'backend',
    ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
    remotePath: '/var/www/app',
    keepReleases: 5,
    healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 3, startupDelay: 0 },
    envFile: '.env',
    nodeVersion: 'lts',
    ...overrides,
  } as ShipnodeConfig;
}

function fakeStrategy(): DeploymentStrategy & { calls: string[] } {
  const calls: string[] = [];

  return {
    name: 'fake',
    async stage(ctx: StrategyContext) {
      calls.push('stage');
    },
    async setupEnvironment(ctx: StrategyContext) {
      calls.push('setupEnvironment');
    },
    async startApp(ctx: StrategyContext) {
      calls.push('startApp');
    },
    calls,
  };
}

describe('DeployOrchestrator', () => {
  it('runs the zero-downtime sequence in order', async () => {
    const executor = new FakeRemoteExecutor();
    const config = makeConfig();

    // Set up executor responses for the ZDT sequence
    executor
      .when((cmd) => cmd.includes('mkdir -p'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('ln -sfn'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('mv -Tf'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('cat') && cmd.includes('releases.json'), { stdout: '[]', exitCode: 0 })
      .when((cmd) => cmd.includes('releases.json') && cmd.includes('base64'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('ls -1t'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('deploy.lock'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('date') && cmd.includes('curl'), { stdout: '200 42', exitCode: 0 });

    const { ReleaseManager, DeployLock } = await import('../../src/domain/release/manager.js');
    const { HealthCheckService } = await import('../../src/services/health.service.js');
    const { CaddyService } = await import('../../src/services/caddy.service.js');

    const releases = new ReleaseManager(executor, config.remotePath, config.keepReleases);
    const lock = new DeployLock(executor, config.remotePath);
    const healthCheck = new HealthCheckService(executor, config);
    const caddy = new CaddyService(executor, config);

    const orchestrator = new DeployOrchestrator(
      config,
      executor,
      releases,
      lock,
      healthCheck,
      caddy,
    );

    const strategy = fakeStrategy();
    await orchestrator.deploy(strategy, { cwd: '/test', skipBuild: false });

    // Verify the strategy methods were called in order
    expect(strategy.calls).toEqual([
      'stage',
      'setupEnvironment',
      'startApp',
    ]);

    // Verify lock was acquired and released
    const history = executor.getHistory();
    const lockAcquire = history.find((h) => h.command.includes('deploy.lock'));
    expect(lockAcquire).toBeDefined();
  });

  it('skips health check when disabled', async () => {
    const executor = new FakeRemoteExecutor();
    const config = makeConfig({
      healthCheck: { enabled: false, path: '/health', timeout: 30, retries: 3, startupDelay: 0 },
    });

    executor
      .when((cmd) => cmd.includes('mkdir -p'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('ln -sfn'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('mv -Tf'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('cat') && cmd.includes('releases.json'), { stdout: '[]', exitCode: 0 })
      .when((cmd) => cmd.includes('releases.json') && cmd.includes('base64'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('ls -1t'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('deploy.lock'), { stdout: 'OK', exitCode: 0 });

    const { ReleaseManager, DeployLock } = await import('../../src/domain/release/manager.js');
    const { HealthCheckService } = await import('../../src/services/health.service.js');
    const { CaddyService } = await import('../../src/services/caddy.service.js');

    const releases = new ReleaseManager(executor, config.remotePath, config.keepReleases);
    const lock = new DeployLock(executor, config.remotePath);
    const healthCheck = new HealthCheckService(executor, config);
    const caddy = new CaddyService(executor, config);

    const orchestrator = new DeployOrchestrator(
      config,
      executor,
      releases,
      lock,
      healthCheck,
      caddy,
    );

    const strategy = fakeStrategy();
    await orchestrator.deploy(strategy, { cwd: '/test', skipBuild: false });

    // Should not run health check curl command
    const history = executor.getHistory();
    const healthCommands = history.filter((h) => h.command.includes('curl'));
    expect(healthCommands).toHaveLength(0);
  });
});

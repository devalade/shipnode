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

function makeConfig(overrides: Record<string, unknown> = {}): ReturnType<typeof assembleConfig> {
  return assembleConfig({
    app: 'backend',
    ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
    remotePath: '/var/www/app',
    keepReleases: 5,
    healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 3, startupDelay: 0 },
    envFile: '.env',
    ...overrides as Parameters<typeof assembleConfig>[0],
  });
}

describe('DeployOrchestrator', () => {
  it('runs the zero-downtime sequence in order for a single app', async () => {
    const executor = new FakeRemoteExecutor();
    const config = makeConfig();

    executor
      .when((cmd) => cmd.includes('deploy.lock'), { stdout: 'OK', exitCode: 0 })
      .when((cmd) => cmd.includes('mkdir -p'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('ln -sfn'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('mv -Tf'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('cat') && cmd.includes('releases.json'), { stdout: '[]', exitCode: 0 })
      .when((cmd) => cmd.includes('releases.json') && cmd.includes('base64'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('ls -1t'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('date') && cmd.includes('curl'), { stdout: '200 42', exitCode: 0 })
      .when((cmd) => cmd.includes('pm2 jlist'), { stdout: '[]', exitCode: 0 });

    const { DeployLock } = await import('../../src/domain/release/manager.js');
    const { HealthCheckService } = await import('../../src/services/health.service.js');
    const { CaddyService } = await import('../../src/services/caddy.service.js');

    const lock = new DeployLock(executor, config.remotePath);
    const healthCheck = new HealthCheckService(executor, config);
    const caddy = new CaddyService(executor, config);

    const orchestrator = new DeployOrchestrator(
      config,
      executor,
      lock,
      healthCheck,
      caddy,
    );

    await orchestrator.deploy({ cwd: '/test', skipBuild: false });

    // Verify lock was acquired and released
    const history = executor.getHistory();
    const lockAcquire = history.find((h) => h.command.includes('deploy.lock'));
    expect(lockAcquire).toBeDefined();
    const lockRelease = history.filter((h) => h.command.includes('rm -rf') && h.command.includes('deploy.lock'));
    expect(lockRelease.length).toBeGreaterThan(0);
  });

  it('loads .env with Node before user preDeploy commands when envFile is configured', async () => {
    const executor = new FakeRemoteExecutor();
    let captured: string | undefined;
    const config = makeConfig({
      envFile: '.env.production',
      hooks: {
        preDeploy: async (ctx: any) => {
          await ctx.exec('node ace.js migration:run');
        },
      },
      healthCheck: { enabled: false, path: '/health', timeout: 30, retries: 3, startupDelay: 0 },
    });

    executor
      .when((cmd) => cmd.includes('deploy.lock'), { stdout: 'OK', exitCode: 0 })
      .when((cmd) => cmd.includes('mkdir -p'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('ln -sfn'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('mv -Tf'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('cat') && cmd.includes('releases.json'), { stdout: '[]', exitCode: 0 })
      .when((cmd) => cmd.includes('releases.json') && cmd.includes('base64'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('ls -1t'), { stdout: '', exitCode: 0 })
      .when((cmd) => {
        if (cmd.includes('migration:run')) captured = cmd;
        return cmd.includes('migration:run');
      }, { stdout: '', exitCode: 0 });

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

    expect(captured).toBeDefined();
    const sourceIdx = captured!.indexOf('base64 --decode');
    const userIdx = captured!.indexOf('node ace.js migration:run');
    expect(sourceIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(sourceIdx);
    expect(captured).not.toContain('set -a');
  });

  it('runs hooks from <workDir>/<appRoot> when appRoot is configured', async () => {
    const executor = new FakeRemoteExecutor();
    let captured: string | undefined;
    const config = makeConfig({
      envFile: '.env.production',
      appRoot: 'apps/backend',
      hooks: {
        preDeploy: async (ctx: any) => {
          await ctx.exec('node build/ace.js migration:run');
        },
      },
      healthCheck: { enabled: false, path: '/health', timeout: 30, retries: 3, startupDelay: 0 },
    });

    executor
      .when((cmd) => cmd.includes('deploy.lock'), { stdout: 'OK', exitCode: 0 })
      .when((cmd) => cmd.includes('mkdir -p'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('ln -sfn'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('mv -Tf'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('cat') && cmd.includes('releases.json'), { stdout: '[]', exitCode: 0 })
      .when((cmd) => cmd.includes('releases.json') && cmd.includes('base64'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('ls -1t'), { stdout: '', exitCode: 0 })
      .when((cmd) => {
        if (cmd.includes('migration:run')) captured = cmd;
        return cmd.includes('migration:run');
      }, { stdout: '', exitCode: 0 });

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

    expect(captured).toBeDefined();
    // cd targets the app subdir; release path is the dynamic releases/<ts> dir.
    expect(captured).toMatch(/cd "\/var\/www\/app\/app\/releases\/[^"]+\/apps\/backend"/);
  });

  it('skips health check when disabled', async () => {
    const executor = new FakeRemoteExecutor();
    const config = makeConfig({
      healthCheck: { enabled: false, path: '/health', timeout: 30, retries: 3, startupDelay: 0 },
    });

    executor
      .when((cmd) => cmd.includes('deploy.lock'), { stdout: 'OK', exitCode: 0 })
      .when((cmd) => cmd.includes('mkdir -p'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('ln -sfn'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('mv -Tf'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('cat') && cmd.includes('releases.json'), { stdout: '[]', exitCode: 0 })
      .when((cmd) => cmd.includes('releases.json') && cmd.includes('base64'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('ls -1t'), { stdout: '', exitCode: 0 });

    const { DeployLock } = await import('../../src/domain/release/manager.js');
    const { HealthCheckService } = await import('../../src/services/health.service.js');
    const { CaddyService } = await import('../../src/services/caddy.service.js');

    const healthCheck = new HealthCheckService(executor, config);
    const caddy = new CaddyService(executor, config);

    const orchestrator = new DeployOrchestrator(
      config,
      executor,
      new DeployLock(executor, config.remotePath),
      healthCheck,
      caddy,
    );

    await orchestrator.deploy({ cwd: '/test', skipBuild: false });

    // Should not run health check curl command
    const history = executor.getHistory();
    const healthCommands = history.filter((h) => h.command.includes('curl'));
    expect(healthCommands).toHaveLength(0);
  });
});

describe('run-once fleet hooks', () => {
  async function deployWith(fleetRole?: { first: boolean; last: boolean }): Promise<string[]> {
    const ran: string[] = [];
    const executor = new FakeRemoteExecutor();
    const config = makeConfig({
      healthCheck: { enabled: false, path: '/health', timeout: 30, retries: 3, startupDelay: 0 },
      hooks: {
        beforeFleet: async (ctx: any) => { ran.push('beforeFleet'); await ctx.exec('migrate'); },
        preDeploy: async (ctx: any) => { ran.push('preDeploy'); await ctx.exec('migrate'); },
        postDeploy: async (ctx: any) => { ran.push('postDeploy'); await ctx.exec('migrate'); },
        afterFleet: async (ctx: any) => { ran.push('afterFleet'); await ctx.exec('migrate'); },
      },
    });

    executor
      .when((cmd) => cmd.includes('deploy.lock'), { stdout: 'OK', exitCode: 0 })
      .when((cmd) => cmd.includes('mkdir -p'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('ln -sfn'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('mv -Tf'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('cat') && cmd.includes('releases.json'), { stdout: '[]', exitCode: 0 })
      .when((cmd) => cmd.includes('releases.json') && cmd.includes('base64'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('ls -1t'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('migrate'), { stdout: '', exitCode: 0 });

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

    await orchestrator.deploy({ cwd: '/test', skipBuild: false, fleetRole });
    return ran;
  }

  it('runs beforeFleet before preDeploy and afterFleet after postDeploy', async () => {
    // beforeFleet has to land while the old code is still serving — the expand
    // half of expand/contract — which is why it precedes the symlink switch.
    expect(await deployWith({ first: true, last: true }))
      .toEqual(['beforeFleet', 'preDeploy', 'postDeploy', 'afterFleet']);
  });

  it('skips both on a middle replica, but still runs the per-replica hooks', async () => {
    expect(await deployWith({ first: false, last: false })).toEqual(['preDeploy', 'postDeploy']);
  });

  it('runs beforeFleet on the first replica only', async () => {
    expect(await deployWith({ first: true, last: false }))
      .toEqual(['beforeFleet', 'preDeploy', 'postDeploy']);
  });

  it('runs afterFleet on the last replica only', async () => {
    expect(await deployWith({ first: false, last: true }))
      .toEqual(['preDeploy', 'postDeploy', 'afterFleet']);
  });

  it('runs both when no role is given, so a single-server deploy is unaffected', async () => {
    expect(await deployWith()).toEqual(['beforeFleet', 'preDeploy', 'postDeploy', 'afterFleet']);
  });
});

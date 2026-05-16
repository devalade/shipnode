import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackendStrategy } from '../../src/domain/deploy/backend-strategy.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import type { ShipnodeConfig } from '../../src/shared/types.js';
import type { StrategyContext } from '../../src/domain/deploy/strategy.js';

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
}));

vi.mock('fs-extra', () => ({
  pathExists: vi.fn().mockResolvedValue(false),
}));

const { execa } = await import('execa');
const { pathExists } = await import('fs-extra');
const mockedExeca = vi.mocked(execa);
const mockedPathExists = vi.mocked(pathExists);

function makeConfig(overrides: Partial<ShipnodeConfig> = {}): ShipnodeConfig {
  return {
    app: 'backend',
    ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
    remotePath: '/var/www/app',
    pm2: { name: 'myapp' },
    backend: { port: 3000 },
    keepReleases: 5,
    healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 3, startupDelay: 0 },
    envFile: '.env',
    nodeVersion: 'lts',
    pkgManager: 'npm',
    ...overrides,
  } as ShipnodeConfig;
}

function makeCtx(executor: FakeRemoteExecutor, overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    config: makeConfig(),
    executor,
    workDir: '/var/www/app/releases/20240101',
    cwd: '/local/project',
    skipBuild: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPathExists.mockResolvedValue(false);
});

// ── stage ─────────────────────────────────────────────────────────

describe('BackendStrategy.stage', () => {
  it('passes SSH port to rsync -e flag', async () => {
    const strategy = new BackendStrategy(makeConfig({ ssh: { host: '1.2.3.4', user: 'deploy', port: 2222 } }), '/local/project');
    await strategy.stage(makeCtx(new FakeRemoteExecutor()));

    const [, args] = mockedExeca.mock.calls[0] as [string, string[]];
    expect(args).toContain('-e');
    expect(args[args.indexOf('-e') + 1]).toBe('ssh -p 2222');
  });

  it('uses port 22 by default', async () => {
    const strategy = new BackendStrategy(makeConfig(), '/local/project');
    await strategy.stage(makeCtx(new FakeRemoteExecutor()));

    const [, args] = mockedExeca.mock.calls[0] as [string, string[]];
    expect(args[args.indexOf('-e') + 1]).toBe('ssh -p 22');
  });

  it('includes --exclude-from when .shipnodeignore exists', async () => {
    mockedPathExists.mockResolvedValue(true);
    const strategy = new BackendStrategy(makeConfig(), '/local/project');
    await strategy.stage(makeCtx(new FakeRemoteExecutor()));

    const [, args] = mockedExeca.mock.calls[0] as [string, string[]];
    expect(args).toContain('--exclude-from');
  });

  it('omits --exclude-from when .shipnodeignore is absent', async () => {
    mockedPathExists.mockResolvedValue(false);
    const strategy = new BackendStrategy(makeConfig(), '/local/project');
    await strategy.stage(makeCtx(new FakeRemoteExecutor()));

    const [, args] = mockedExeca.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--exclude-from');
  });

  it('syncs from local cwd to remote workDir', async () => {
    const strategy = new BackendStrategy(makeConfig(), '/local/project');
    const ctx = makeCtx(new FakeRemoteExecutor(), { workDir: '/var/www/app/releases/abc' });
    await strategy.stage(ctx);

    const [cmd, args] = mockedExeca.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('rsync');
    expect(args.at(-2)).toBe('/local/project/');
    expect(args.at(-1)).toBe('deploy@1.2.3.4:/var/www/app/releases/abc/');
  });
});

// ── setupEnvironment ──────────────────────────────────────────────

describe('BackendStrategy.setupEnvironment', () => {
  it('runs mise and npm install', async () => {
    const strategy = new BackendStrategy(makeConfig({ pkgManager: 'npm' }), '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.setupEnvironment!(makeCtx(executor));

    const cmd = executor.getLastCommand()!.command;
    expect(cmd).toContain('mise use -y "node@lts"');
    expect(cmd).toContain('npm ci');
  });

  it('uses pnpm install when pkgManager is pnpm', async () => {
    const strategy = new BackendStrategy(makeConfig({ pkgManager: 'pnpm' }), '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.setupEnvironment!(makeCtx(executor));

    const cmd = executor.getLastCommand()!.command;
    expect(cmd).toContain('pnpm install');
  });

  it('includes build step when skipBuild is false', async () => {
    const strategy = new BackendStrategy(makeConfig(), '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.setupEnvironment!(makeCtx(executor, { skipBuild: false }));

    const cmd = executor.getLastCommand()!.command;
    expect(cmd).toContain('run build');
  });

  it('omits build step when skipBuild is true', async () => {
    const strategy = new BackendStrategy(makeConfig(), '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.setupEnvironment!(makeCtx(executor, { skipBuild: true }));

    const cmd = executor.getLastCommand()!.command;
    expect(cmd).not.toContain('run build');
  });

  it('links shared dirs when configured', async () => {
    const strategy = new BackendStrategy(
      makeConfig({ sharedDirs: ['uploads', 'logs'] }),
      '/local/project',
    );
    const executor = new FakeRemoteExecutor();
    await strategy.setupEnvironment!(makeCtx(executor));

    const cmd = executor.getLastCommand()!.command;
    expect(cmd).toContain('uploads');
    expect(cmd).toContain('logs');
    expect(cmd).toContain('ln -sfn');
  });

  it('links shared files when configured', async () => {
    const strategy = new BackendStrategy(
      makeConfig({ sharedFiles: ['config.json'] }),
      '/local/project',
    );
    const executor = new FakeRemoteExecutor();
    await strategy.setupEnvironment!(makeCtx(executor));

    const cmd = executor.getLastCommand()!.command;
    expect(cmd).toContain('config.json');
    expect(cmd).toContain('ln -sf');
  });

  it('links shared .env', async () => {
    const strategy = new BackendStrategy(makeConfig(), '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.setupEnvironment!(makeCtx(executor));

    const cmd = executor.getLastCommand()!.command;
    expect(cmd).toContain('shared/.env');
  });
});

// ── startApp ──────────────────────────────────────────────────────

describe('BackendStrategy.startApp', () => {
  it('is a no-op when pm2 is not configured', async () => {
    const strategy = new BackendStrategy(makeConfig({ pm2: undefined }), '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.startApp!(makeCtx(executor));

    expect(executor.getHistory()).toHaveLength(0);
  });

  it('writes ecosystem file and reloads pm2', async () => {
    const strategy = new BackendStrategy(makeConfig({ pm2: { name: 'myapp' } }), '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.startApp!(makeCtx(executor));

    const history = executor.getHistory();
    expect(history).toHaveLength(3);
    expect(history[0].command).toContain('ecosystem.config.cjs');
    expect(history[1].command).toContain('--prefer-offline');
    expect(history[2].command).toContain('pm2 startOrReload');
    expect(history[2].command).toContain('pm2 save');
  });

  it('ecosystem file contains app name and port', async () => {
    const strategy = new BackendStrategy(
      makeConfig({ pm2: { name: 'api-server' }, backend: { port: 8080 } }),
      '/local/project',
    );
    const executor = new FakeRemoteExecutor();
    await strategy.startApp!(makeCtx(executor));

    const writeCmd = executor.getHistory()[0].command;
    expect(writeCmd).toContain('api-server');
    expect(writeCmd).toContain('8080');
  });

  it('ecosystem file uses custom instances and maxMemory', async () => {
    const strategy = new BackendStrategy(
      makeConfig({ pm2: { name: 'app', instances: 4, maxMemory: '1G' } }),
      '/local/project',
    );
    const executor = new FakeRemoteExecutor();
    await strategy.startApp!(makeCtx(executor));

    const writeCmd = executor.getHistory()[0].command;
    expect(writeCmd).toContain('instances: 4');
    expect(writeCmd).toContain("'1G'");
  });

  it('ecosystem path uses shared dir', async () => {
    const strategy = new BackendStrategy(makeConfig(), '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.startApp!(makeCtx(executor));

    const writeCmd = executor.getHistory()[0].command;
    expect(writeCmd).toContain('/var/www/app/shared/ecosystem.config.cjs');
  });
});

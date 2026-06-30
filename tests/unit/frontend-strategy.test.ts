import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FrontendStrategy } from '../../src/domain/deploy/frontend-strategy.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import { assembleConfig } from '../../src/config/assembly.js';
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

function makeConfig(overrides: Record<string, unknown> = {}): ReturnType<typeof assembleConfig> {
  return assembleConfig({
    app: 'frontend',
    ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
    remotePath: '/var/www/app',
    keepReleases: 5,
    healthCheck: { enabled: false, path: '/health', timeout: 30, retries: 3, startupDelay: 0 },
    envFile: '.env',
    nodeVersion: 'lts',
    pkgManager: 'npm',
    ...overrides as Parameters<typeof assembleConfig>[0],
  });
}

function makeCtx(overrides: Partial<StrategyContext> = {}): StrategyContext {
  const baseConfig = makeConfig();
  const ctx: Partial<StrategyContext> = {
    config: baseConfig,
    executor: new FakeRemoteExecutor(),
    workDir: '/var/www/app/releases/20240101',
    cwd: '/local/project',
    skipBuild: false,
    ...overrides,
  };
  if (!ctx.app && ctx.config) {
    ctx.app = ctx.config.apps[0];
  }
  return ctx as StrategyContext;
}

function makeStrategy(config: ReturnType<typeof assembleConfig>, cwd: string): FrontendStrategy {
  return new FrontendStrategy(config, config.apps[0], cwd);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPathExists.mockResolvedValue(false);
});

// ── stage ─────────────────────────────────────────────────────────

describe('FrontendStrategy.stage', () => {
  it('runs local build then rsync (two execa calls)', async () => {
    const strategy = makeStrategy(makeConfig(), '/local/project');
    await strategy.stage(makeCtx({ skipBuild: false }));

    // First call: local build; second call: rsync
    expect(mockedExeca).toHaveBeenCalledTimes(2);
    const [rsyncCmd] = mockedExeca.mock.calls[1] as [string, string[]];
    expect(rsyncCmd).toBe('rsync');
  });

  it('skips local build when skipBuild is true', async () => {
    const strategy = makeStrategy(makeConfig(), '/local/project');
    await strategy.stage(makeCtx({ skipBuild: true }));

    expect(mockedExeca).toHaveBeenCalledTimes(1);
    const [cmd] = mockedExeca.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('rsync');
  });

  it('passes SSH port to rsync -e flag', async () => {
    const strategy = makeStrategy(
      makeConfig({ ssh: { host: '1.2.3.4', user: 'deploy', port: 2222 } }),
      '/local/project',
    );
    await strategy.stage(makeCtx({ skipBuild: true }));

    const [, args] = mockedExeca.mock.calls[0] as [string, string[]];
    expect(args).toContain('-e');
    expect(args[args.indexOf('-e') + 1]).toBe('ssh -p 2222');
  });

  it('includes --delete in rsync args', async () => {
    const strategy = makeStrategy(makeConfig(), '/local/project');
    await strategy.stage(makeCtx({ skipBuild: true }));

    const [, args] = mockedExeca.mock.calls[0] as [string, string[]];
    expect(args).toContain('--delete');
  });

  it('includes --exclude-from when .shipnodeignore exists', async () => {
    mockedPathExists.mockImplementation(async (p) =>
      p.toString().endsWith('.shipnodeignore'),
    );

    const strategy = makeStrategy(makeConfig(), '/local/project');
    await strategy.stage(makeCtx({ skipBuild: true }));

    const [, args] = mockedExeca.mock.calls[0] as [string, string[]];
    expect(args).toContain('--exclude-from');
  });

  it('omits --exclude-from when .shipnodeignore is absent', async () => {
    mockedPathExists.mockResolvedValue(false);

    const strategy = makeStrategy(makeConfig(), '/local/project');
    await strategy.stage(makeCtx({ skipBuild: true }));

    const [, args] = mockedExeca.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--exclude-from');
  });

  it('uses config.buildDir when set', async () => {
    const strategy = makeStrategy(
      makeConfig({ buildDir: 'my-custom-build' }),
      '/local/project',
    );
    await strategy.stage(makeCtx({ skipBuild: true }));

    const [, args] = mockedExeca.mock.calls[0] as [string, string[]];
    expect(args.at(-2)).toContain('my-custom-build');
  });

  it('auto-detects build dir: "build" takes priority over "dist"', async () => {
    mockedPathExists.mockImplementation(async (p) =>
      p.toString().endsWith('/build'),
    );

    const strategy = makeStrategy(makeConfig(), '/local/project');
    await strategy.stage(makeCtx({ skipBuild: true }));

    const [, args] = mockedExeca.mock.calls[0] as [string, string[]];
    expect(args.at(-2)).toContain('/build/');
  });

  it('falls back to "dist" when no build dir found', async () => {
    mockedPathExists.mockResolvedValue(false);

    const strategy = makeStrategy(makeConfig(), '/local/project');
    await strategy.stage(makeCtx({ skipBuild: true }));

    const [, args] = mockedExeca.mock.calls[0] as [string, string[]];
    expect(args.at(-2)).toContain('/dist/');
  });

  it('detects "public" build dir', async () => {
    mockedPathExists.mockImplementation(async (p) =>
      p.toString().endsWith('/public'),
    );

    const strategy = makeStrategy(makeConfig(), '/local/project');
    await strategy.stage(makeCtx({ skipBuild: true }));

    const [, args] = mockedExeca.mock.calls[0] as [string, string[]];
    expect(args.at(-2)).toContain('/public/');
  });

  it('uses pnpm run build when pkgManager is pnpm', async () => {
    const strategy = makeStrategy(
      makeConfig({ pkgManager: 'pnpm' }),
      '/local/project',
    );
    await strategy.stage(makeCtx({ skipBuild: false }));

    const [buildCmd, buildArgs] = mockedExeca.mock.calls[0] as [string, string[]];
    expect(buildCmd).toBe('pnpm');
    expect(buildArgs).toContain('build');
  });
});

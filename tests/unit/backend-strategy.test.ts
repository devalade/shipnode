import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackendStrategy } from '../../src/domain/deploy/backend-strategy.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import type { ShipnodeConfig } from '../../src/shared/types.js';
import type { StrategyContext } from '../../src/domain/deploy/strategy.js';
import { assembleConfig } from '../../src/config/assembly.js';

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
  // Route through assembleConfig so the legacy pm2/backend shape in overrides
  // gets normalised into the canonical pm2.apps form, matching real usage.
  return assembleConfig({
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
  });
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

  it('uses the custom installCommand override when set', async () => {
    const config = makeConfig({ pkgManager: 'npm', installCommand: 'npm ci --legacy-peer-deps' });
    const strategy = new BackendStrategy(config, '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.setupEnvironment!(makeCtx(executor, { config }));

    const cmd = executor.getLastCommand()!.command;
    expect(cmd).toContain('npm ci --legacy-peer-deps');
    expect(cmd).not.toContain('npm ci\n'); // not the default
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

  it('symlinks .env into appRoot/build when appRoot is configured (monorepo)', async () => {
    const config = makeConfig({ appRoot: 'apps/backend' });
    const strategy = new BackendStrategy(config, '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.setupEnvironment!(makeCtx(executor, { config }));

    const cmd = executor.getLastCommand()!.command;
    expect(cmd).toContain('"apps/backend/build"');
    expect(cmd).toContain('"apps/backend/dist"');
  });

  it('also scans apps/*/build and packages/*/build for monorepos (no appRoot)', async () => {
    const strategy = new BackendStrategy(makeConfig(), '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.setupEnvironment!(makeCtx(executor));

    const cmd = executor.getLastCommand()!.command;
    expect(cmd).toContain('apps/*/build');
    expect(cmd).toContain('packages/*/build');
    expect(cmd).toContain('"build"');
    expect(cmd).toContain('"dist"');
  });

  it('sources .env before install so private-registry tokens (npmrc ${VAR}) resolve', async () => {
    const strategy = new BackendStrategy(makeConfig({ pkgManager: 'pnpm' }), '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.setupEnvironment!(makeCtx(executor));

    const cmd = executor.getLastCommand()!.command;
    const sourceIdx = cmd.indexOf('set -a && . ./.env && set +a');
    const installIdx = cmd.indexOf('pnpm install');
    expect(sourceIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(sourceIdx);
  });

  it('links the shared env using the configured envFile name, not a hardcoded .env', async () => {
    const config = makeConfig({ envFile: '.env.production' });
    const strategy = new BackendStrategy(config, '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.setupEnvironment!(makeCtx(executor, { config }));

    const cmd = executor.getLastCommand()!.command;
    expect(cmd).toContain('shared/.env.production');
    expect(cmd).toContain('ln -sf "/var/www/app/shared/.env.production" .env');
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
    expect(history[2].command).toContain('pm2 delete');
    expect(history[2].command).toContain('pm2 start');
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

  it('ecosystem path is per-release (ADR-0001)', async () => {
    const strategy = new BackendStrategy(makeConfig(), '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.startApp!(makeCtx(executor));

    const writeCmd = executor.getHistory()[0].command;
    // Written into the release dir (workDir); referenced at runtime via /current symlink.
    expect(writeCmd).toContain('/var/www/app/releases/20240101/ecosystem.config.cjs');
    const startCmd = executor.getHistory()[2].command;
    expect(startCmd).toContain('/var/www/app/current/ecosystem.config.cjs');
  });

  it('generates multiple app blocks for workers', async () => {
    const config = assembleConfig({
      app: 'backend',
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      remotePath: '/var/www/app',
      pm2: {
        apps: [
          { name: 'api', port: 3000 },
          { name: 'mailer', command: 'node dist/worker.js' },
          { name: 'cron', command: 'node dist/cron.js', env: { JOB: 'cleanup' } },
        ],
      },
      pkgManager: 'pnpm',
    });
    const strategy = new BackendStrategy(config, '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.startApp!(makeCtx(executor, { config }));

    // The recorded command is shell-escaped (single quotes become '"'"'),
    // so assert on substrings that don't span quotes.
    const writeCmd = executor.getHistory()[0].command;
    expect(writeCmd).toContain('api');
    expect(writeCmd).toContain('mailer');
    expect(writeCmd).toContain('cron');
    expect(writeCmd).toContain('node');
    expect(writeCmd).toContain('dist/worker.js');
    expect(writeCmd).toContain('dist/cron.js');
    expect(writeCmd).toContain('PORT: 3000');
    expect(writeCmd).toContain('JOB');
    expect(writeCmd).toContain('cleanup');
    expect(writeCmd).toContain('/var/www/app/shared/.env');
    expect(writeCmd).toContain('namespace');
  });

  it('skips the port-in-use guard when no app has a port (worker-only)', async () => {
    const config = assembleConfig({
      app: 'backend',
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      remotePath: '/var/www/app',
      pm2: { apps: [{ name: 'worker', command: 'node dist/worker.js' }] },
      pkgManager: 'npm',
    });
    const strategy = new BackendStrategy(config, '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.startApp!(makeCtx(executor, { config }));

    const startCmd = executor.getHistory()[2].command;
    expect(startCmd).not.toContain('ss -tlnp');
  });

  it('prefixes worker names with the deployment namespace for global uniqueness', async () => {
    const config = assembleConfig({
      app: 'backend',
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      remotePath: '/var/www/app',
      pm2: { apps: [{ name: 'api', port: 3000 }, { name: 'worker' }] },
      pkgManager: 'npm',
    });
    const strategy = new BackendStrategy(config, '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.startApp!(makeCtx(executor, { config }));

    const writeCmd = executor.getHistory()[0].command;
    // Web app's PM2 name equals the namespace (no prefix).
    expect(writeCmd).toContain('api');
    // Worker is namespace-prefixed: two shipnode deployments with a `worker`
    // entry on the same host won't collide because each gets prefixed.
    expect(writeCmd).toContain('api-worker');
  });

  it('uses the custom installCommand on the post-symlink relink (no --prefer-offline appended)', async () => {
    const config = makeConfig({ pkgManager: 'npm', installCommand: 'npm ci --legacy-peer-deps' });
    const strategy = new BackendStrategy(config, '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.startApp!(makeCtx(executor, { config }));

    const relinkCmd = executor.getHistory()[1].command;
    expect(relinkCmd).toContain('npm ci --legacy-peer-deps');
    expect(relinkCmd).not.toContain('--prefer-offline');
  });

  it('emits the silent legacy-name pm2 delete fallback', async () => {
    const strategy = new BackendStrategy(makeConfig({ pm2: { name: 'myapp' } }), '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.startApp!(makeCtx(executor));

    const startCmd = executor.getHistory()[2].command;
    expect(startCmd).toContain('pm2 delete "myapp"');
  });

  it('throws DeployError when pnpm reports ERR_PNPM_IGNORED_BUILDS during startApp install', async () => {
    const strategy = new BackendStrategy(makeConfig({ pkgManager: 'pnpm' }), '/local/project');
    const executor = new FakeRemoteExecutor();

    executor.when(
      (cmd) => cmd.includes('--prefer-offline'),
      {
        stdout: '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @prisma/client@6.19.3, bcrypt@5.1.1\nRun "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.',
        stderr: '',
        exitCode: 0,
      },
    );

    await expect(strategy.startApp!(makeCtx(executor))).rejects.toThrow('pnpm approve-builds');
  });

  it('drops the env_file ecosystem entry in favor of a bash -c env wrapper (ADR-0003)', async () => {
    const strategy = new BackendStrategy(makeConfig({ envFile: '.env.production' }), '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.startApp!(makeCtx(executor));

    const writeCmd = executor.getHistory()[0].command;
    expect(writeCmd).not.toContain('env_file:');
    expect(writeCmd).toContain(`script: '"'"'bash'"'"',`);
    expect(writeCmd).toContain('shared/.env.production');
    expect(writeCmd).toContain('set -a');
    expect(writeCmd).toContain('exec');
  });

  it('sets PM2 cwd to <remotePath>/current/<appRoot> when appRoot is configured', async () => {
    const config = makeConfig({ appRoot: 'apps/backend' });
    const strategy = new BackendStrategy(config, '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.startApp!(makeCtx(executor, { config }));

    const writeCmd = executor.getHistory()[0].command;
    // PM2 launches the script from inside the app dir so `pnpm start` reads
    // apps/backend/package.json, not the workspace root.
    expect(writeCmd).toContain('/var/www/app/current/apps/backend');
    expect(writeCmd).toMatch(/cwd:/);
  });

  it('omits PM2 cwd when no appRoot — single-app layout stays default', async () => {
    const strategy = new BackendStrategy(makeConfig(), '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.startApp!(makeCtx(executor));

    const writeCmd = executor.getHistory()[0].command;
    expect(writeCmd).not.toMatch(/cwd:/);
  });

  it('wraps worker commands too so workers see the same env as the web app', async () => {
    const config = assembleConfig({
      app: 'backend',
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      remotePath: '/var/www/app',
      pm2: { apps: [
        { name: 'api', port: 3000 },
        { name: 'worker', command: 'node dist/worker.js --queue=mail' },
      ] },
      envFile: '.env.production',
      pkgManager: 'npm',
    });
    const strategy = new BackendStrategy(config, '/local/project');
    const executor = new FakeRemoteExecutor();
    await strategy.startApp!(makeCtx(executor, { config }));

    const writeCmd = executor.getHistory()[0].command;
    expect(writeCmd).toContain('exec node dist/worker.js --queue=mail');
  });

  it('throws DeployError when pnpm reports ERR_PNPM_IGNORED_BUILDS during setupEnvironment', async () => {
    const strategy = new BackendStrategy(makeConfig({ pkgManager: 'pnpm' }), '/local/project');
    const executor = new FakeRemoteExecutor();

    executor.when(
      (cmd) => cmd.includes('pnpm install'),
      {
        stdout: '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @prisma/client@6.19.3\nRun "pnpm approve-builds"',
        stderr: '',
        exitCode: 0,
      },
    );

    await expect(strategy.setupEnvironment!(makeCtx(executor))).rejects.toThrow('pnpm approve-builds');
  });
});

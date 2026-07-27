import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { HotSync, touchesDependencies } from '../../src/domain/deploy/hot-sync.js';
import { HealthCheckService } from '../../src/services/health.service.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import { assembleConfig } from '../../src/config/assembly.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('fs-extra', () => ({
  pathExists: vi.fn(),
}));

const { execa } = await import('execa');
const { pathExists } = await import('fs-extra');
const mockedExeca = vi.mocked(execa);
const mockedPathExists = vi.mocked(pathExists);

type Config = ReturnType<typeof assembleConfig>;

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return assembleConfig({
    app: 'backend',
    ssh: { host: '1.2.3.4', user: 'deploy', port: 2222 },
    remotePath: '/var/www',
    pm2: { apps: [{ name: 'api', port: 3000 }] },
    keepReleases: 5,
    healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 2, startupDelay: 5 },
    envFile: '.env',
    pkgManager: 'npm',
    ...(overrides as Parameters<typeof assembleConfig>[0]),
  });
}

function makeHotSync(
  executor: FakeRemoteExecutor,
  config: Config = makeConfig(),
  options: {
    buildLocation?: 'remote' | 'local' | 'none';
    fileListThreshold?: number;
    healthRetries?: number;
  } = {},
): HotSync {
  return new HotSync(
    config,
    config.apps[0],
    executor,
    '/local/project',
    new HealthCheckService(executor, config),
    {
      buildLocation: options.buildLocation ?? 'remote',
      fileListThreshold: options.fileListThreshold,
      healthProbe: {
        retries: options.healthRetries ?? 2,
        timeoutSeconds: 5,
        backoff: { initialMs: 1, maxMs: 2 },
      },
    },
  );
}

/** Healthy HTTP probe: `<status> <ms>`. */
function healthyExecutor(): FakeRemoteExecutor {
  return new FakeRemoteExecutor().when(
    (cmd) => cmd.includes('curl'),
    { stdout: '200 12', stderr: '', exitCode: 0 },
  );
}

/** rsync args from the nth execa call. */
function rsyncArgs(call = 0): string[] {
  return mockedExeca.mock.calls[call]?.[1] as string[];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedExeca.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as never);
  // Default: no .shipnodeignore, and every changed path still exists.
  mockedPathExists.mockImplementation(async (path: string) =>
    !String(path).endsWith('.shipnodeignore'),
  );
});

describe('touchesDependencies', () => {
  it('detects manifests and lockfiles at any depth', () => {
    expect(touchesDependencies(['src/index.ts'])).toBe(false);
    expect(touchesDependencies(['package.json'])).toBe(true);
    expect(touchesDependencies(['apps/api/package.json'])).toBe(true);
    expect(touchesDependencies(['pnpm-lock.yaml'])).toBe(true);
    expect(touchesDependencies(['src/a.ts', 'yarn.lock'])).toBe(true);
  });
});

describe('HotSync — incremental rsync', () => {
  it('hands rsync an explicit file list instead of scanning the tree', async () => {
    const contents: string[] = [];
    mockedExeca.mockImplementation(((_bin: string, args: string[]) => {
      const index = args.indexOf('--files-from');
      if (index !== -1) contents.push(readFileSync(args[index + 1], 'utf8'));
      return Promise.resolve({ stdout: 'src/index.ts', stderr: '', exitCode: 0 });
    }) as never);

    const result = await makeHotSync(healthyExecutor()).run(['src/index.ts', 'src/routes.ts']);

    const args = rsyncArgs();
    expect(args).toContain('--files-from');
    // `--files-from` cancels the recursion implied by `-a`.
    expect(args).toContain('-r');
    expect(contents[0]).toBe('src/index.ts\nsrc/routes.ts\n');
    expect(result.mode).toBe('incremental');
    expect(result.transferredFiles).toBe(1);
  });

  it('syncs to the live release over the configured ssh port', async () => {
    await makeHotSync(healthyExecutor()).run(['src/index.ts']);

    const args = rsyncArgs();
    expect(args).toContain('-e');
    expect(args).toContain('ssh -p 2222');
    expect(args[args.length - 1]).toBe('deploy@1.2.3.4:/var/www/api/current/');
  });

  it('never passes --delete: the live release holds files the local tree lacks', async () => {
    await makeHotSync(healthyExecutor()).run(['src/index.ts']);

    expect(rsyncArgs()).not.toContain('--delete');
  });

  it('excludes node_modules and .env from the sync', async () => {
    await makeHotSync(healthyExecutor()).run(['src/index.ts']);

    const args = rsyncArgs();
    expect(args).toContain('node_modules');
    expect(args).toContain('.env');
  });

  it('falls back to a full-tree sync when a changed path was deleted', async () => {
    mockedPathExists.mockImplementation(async (path: string) => {
      if (String(path).endsWith('.shipnodeignore')) return false;
      return !String(path).endsWith('removed.ts');
    });

    const result = await makeHotSync(healthyExecutor()).run(['src/index.ts', 'src/removed.ts']);

    expect(rsyncArgs()).not.toContain('--files-from');
    expect(result.mode).toBe('full');
  });

  it('falls back to a full-tree sync when the change set is large', async () => {
    const paths = Array.from({ length: 5 }, (_, i) => `src/file${i}.ts`);

    const result = await makeHotSync(healthyExecutor(), makeConfig(), { fileListThreshold: 3 })
      .run(paths);

    expect(rsyncArgs()).not.toContain('--files-from');
    expect(result.mode).toBe('full');
  });

  it('counts only files, not directory entries, as transferred', async () => {
    mockedExeca.mockResolvedValue({
      stdout: './\nsrc/\nsrc/index.ts\nsrc/routes.ts',
      stderr: '',
      exitCode: 0,
    } as never);

    const result = await makeHotSync(healthyExecutor()).run(['src/index.ts']);

    expect(result.transferredFiles).toBe(2);
  });
});

describe('HotSync — remote install and build', () => {
  it('skips install when no dependency manifest changed', async () => {
    const executor = healthyExecutor();
    const result = await makeHotSync(executor).run(['src/index.ts']);

    const commands = executor.getHistory().map((entry) => entry.command).join('\n');
    expect(commands).not.toContain('npm ci');
    expect(result.installed).toBe(false);
  });

  it('installs offline-first when a lockfile changed', async () => {
    const executor = healthyExecutor();
    const result = await makeHotSync(executor).run(['package-lock.json']);

    const commands = executor.getHistory().map((entry) => entry.command).join('\n');
    expect(commands).toContain('npm ci --prefer-offline');
    expect(result.installed).toBe(true);
  });

  it('uses a custom installCommand verbatim', async () => {
    const executor = healthyExecutor();
    await makeHotSync(executor, makeConfig({ installCommand: 'npm install --legacy-peer-deps' }))
      .run(['package.json']);

    const commands = executor.getHistory().map((entry) => entry.command).join('\n');
    expect(commands).toContain('npm install --legacy-peer-deps');
    expect(commands).not.toContain('--prefer-offline');
  });

  it('builds in the live release and re-links .env into build output', async () => {
    const executor = healthyExecutor();
    const result = await makeHotSync(executor).run(['src/index.ts']);

    const build = executor.getHistory().find((entry) => entry.command.includes('scripts.build'));
    expect(build).toBeDefined();
    expect(build?.command).toContain('cd "/var/www/api/current"');
    // A build that recreates its output dir drops the symlink; it must return.
    expect(build?.command).toContain('ln -sf "/var/www/api/current/.env"');
    expect(result.built).toBe(true);
  });

  it('skips the build entirely with buildLocation none', async () => {
    const executor = healthyExecutor();
    const result = await makeHotSync(executor, makeConfig(), { buildLocation: 'none' }).run(['src/index.ts']);

    const commands = executor.getHistory().map((entry) => entry.command).join('\n');
    expect(commands).not.toContain('scripts.build');
    expect(result.built).toBe(false);
  });

  it('reports install failures as errors rather than reloading broken code', async () => {
    const executor = healthyExecutor().when(
      (cmd) => cmd.includes('--prefer-offline'),
      { stdout: '', stderr: 'ERESOLVE could not resolve', exitCode: 1 },
    );

    await expect(makeHotSync(executor).run(['package.json'])).rejects.toThrow('ERESOLVE');
  });
});

describe('HotSync — reload', () => {
  it('reloads the recreate ecosystem file for a non-blue-green app', async () => {
    const executor = healthyExecutor();
    const result = await makeHotSync(executor).run(['src/index.ts']);

    const reload = executor.getHistory().find((entry) => entry.command.includes('pm2 reload'));
    expect(reload?.command).toContain('/var/www/api/current/ecosystem.config.cjs');
    expect(result.reloaded).toBe(true);
  });

  it('reloads only the serving colour, leaving the idle colour as a rollback target', async () => {
    const config = makeConfig({ zeroDowntime: true, domain: 'example.com' });
    const executor = healthyExecutor().when(
      (cmd) => cmd.includes('deploy-state.json'),
      { stdout: JSON.stringify({ activeColor: 'green', bluePort: 3000, greenPort: 13000 }), stderr: '', exitCode: 0 },
    );

    await makeHotSync(executor, config).run(['src/index.ts']);

    const reload = executor.getHistory().find((entry) => entry.command.includes('pm2 reload'));
    expect(reload?.command).toContain('ecosystem.web.config.cjs');
    expect(reload?.command).toContain('ecosystem.workers.config.cjs');
    // The plain recreate ecosystem would start a second, uncoloured web process.
    expect(reload?.command).not.toContain('current/ecosystem.config.cjs');
  });

  it('fails clearly when the live release has no ecosystem file', async () => {
    const executor = healthyExecutor().when(
      (cmd) => cmd.includes('pm2 reload'),
      { stdout: '', stderr: 'no ecosystem file in the live release', exitCode: 1 },
    );

    await expect(makeHotSync(executor).run(['src/index.ts'])).rejects.toThrow('no ecosystem file');
  });
});

describe('HotSync — health probe', () => {
  it('probes the active blue-green colour, not the configured port', async () => {
    const config = makeConfig({ zeroDowntime: true, domain: 'example.com' });
    const executor = healthyExecutor().when(
      (cmd) => cmd.includes('deploy-state.json'),
      { stdout: JSON.stringify({ activeColor: 'green', bluePort: 3000, greenPort: 13000 }), stderr: '', exitCode: 0 },
    );

    const result = await makeHotSync(executor, config).run(['src/index.ts']);

    const probe = executor.getHistory().find((entry) => entry.command.includes('curl'));
    expect(probe?.command).toContain('http://localhost:13000/health');
    expect(result.health).toBe('passed');
  });

  it('skips the PM2 status check, which reload always trips', async () => {
    const executor = healthyExecutor();
    await makeHotSync(executor).run(['src/index.ts']);

    const commands = executor.getHistory().map((entry) => entry.command).join('\n');
    // `pm2 reload` increments restart_time, which the status check reads as a
    // startup crash — HTTP is the only meaningful signal here.
    expect(commands).not.toContain('pm2 jlist');
  });

  it('reports an unhealthy app without throwing, so watching continues', async () => {
    const executor = new FakeRemoteExecutor()
      .when((cmd) => cmd.includes('curl'), { stdout: '502 3', stderr: '', exitCode: 0 })
      .when((cmd) => cmd.includes('tail -15'), { stdout: 'Error: boom', stderr: '', exitCode: 0 });

    const result = await makeHotSync(executor).run(['src/index.ts']);

    expect(result.health).toBe('failed');
    expect(result.healthError).toContain('502');
    expect(result.reloaded).toBe(true);
  });

  it('skips the probe when health checks are disabled', async () => {
    const config = makeConfig({
      healthCheck: { enabled: false, path: '/health', timeout: 30, retries: 2, startupDelay: 0 },
    });
    const executor = healthyExecutor();

    const result = await makeHotSync(executor, config).run(['src/index.ts']);

    expect(result.health).toBe('skipped');
  });
});

describe('HotSync — frontend apps', () => {
  function frontendConfig(): Config {
    return assembleConfig({
      app: 'frontend',
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      remotePath: '/var/www',
      domain: 'example.com',
      buildDir: 'dist',
      keepReleases: 5,
      pkgManager: 'npm',
    } as Parameters<typeof assembleConfig>[0]);
  }

  it('builds locally then mirrors build output over the live release', async () => {
    const config = frontendConfig();
    const executor = new FakeRemoteExecutor();

    const result = await makeHotSync(executor, config).run(['src/App.tsx']);

    expect(mockedExeca).toHaveBeenCalledWith('npm', ['run', 'build'], expect.objectContaining({
      cwd: '/local/project',
    }));
    const args = rsyncArgs(1);
    expect(args).toContain('--delete');
    expect(args[args.length - 2]).toBe('/local/project/dist/');
    expect(result.built).toBe(true);
    // Static files need no process reload and expose no health endpoint.
    expect(result.reloaded).toBe(false);
    expect(result.health).toBe('skipped');
    expect(executor.getHistory()).toHaveLength(0);
  });
});

describe('HotSync — build location', () => {
  it('builds locally in appRoot, not the workspace root', async () => {
    const config = makeConfig({ appRoot: 'apps/api', pkgManager: 'pnpm' });
    const executor = healthyExecutor();

    const result = await makeHotSync(executor, config, { buildLocation: 'local' })
      .run(['apps/api/src/index.ts']);

    // The `build` script belongs to the app package, not the workspace root.
    expect(mockedExeca).toHaveBeenCalledWith('pnpm', ['build'], expect.objectContaining({
      cwd: '/local/project/apps/api',
    }));
    expect(result.built).toBe(true);
  });

  it('builds locally before syncing, so the fresh artifact ships this cycle', async () => {
    const config = makeConfig({ appRoot: 'apps/api' });
    const calls: string[] = [];
    mockedExeca.mockImplementation(((bin: string) => {
      calls.push(bin);
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    }) as never);

    await makeHotSync(healthyExecutor(), config, { buildLocation: 'local' })
      .run(['apps/api/src/index.ts']);

    expect(calls).toEqual(['npm', 'rsync']);
  });

  it('never builds on the server when building locally', async () => {
    const executor = healthyExecutor();
    await makeHotSync(executor, makeConfig(), { buildLocation: 'local' }).run(['src/index.ts']);

    const commands = executor.getHistory().map((entry) => entry.command).join('\n');
    expect(commands).not.toContain('scripts.build');
  });

  it('still installs remotely on a lockfile change while building locally', async () => {
    const executor = healthyExecutor();
    const result = await makeHotSync(executor, makeConfig(), { buildLocation: 'local' })
      .run(['pnpm-lock.yaml']);

    const commands = executor.getHistory().map((entry) => entry.command).join('\n');
    expect(commands).toContain('--prefer-offline');
    expect(result.installed).toBe(true);
  });

  it('with buildLocation none, only syncs and reloads', async () => {
    const executor = healthyExecutor();
    const result = await makeHotSync(executor, makeConfig(), { buildLocation: 'none' })
      .run(['src/index.ts']);

    const commands = executor.getHistory().map((entry) => entry.command).join('\n');
    expect(commands).not.toContain('scripts.build');
    // Only rsync ran locally — no local build.
    expect(mockedExeca).toHaveBeenCalledTimes(1);
    expect(result.built).toBe(false);
    expect(result.reloaded).toBe(true);
  });
});

describe('HotSync — local build must not starve the sync', () => {
  it('scans the tree when building locally, since the watcher hides build output', async () => {
    // The watcher cannot report `.output/` under `local` (that would re-trigger
    // the cycle that wrote it), so a file list would omit the fresh artifact
    // entirely and ship nothing but source.
    const result = await makeHotSync(healthyExecutor(), makeConfig(), { buildLocation: 'local' })
      .run(['src/index.ts']);

    const args = mockedExeca.mock.calls.find((call) => call[0] === 'rsync')?.[1] as string[];
    expect(args).not.toContain('--files-from');
    expect(result.mode).toBe('full');
  });

  it('still uses an explicit file list when the build is not ours to run', async () => {
    for (const buildLocation of ['remote', 'none'] as const) {
      vi.clearAllMocks();
      mockedExeca.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as never);

      const result = await makeHotSync(healthyExecutor(), makeConfig(), { buildLocation })
        .run(['src/index.ts']);

      expect(result.mode).toBe('incremental');
    }
  });
});

describe('HotSync — a local build must not re-trigger itself', () => {
  it('suppresses watching while the build writes inside the source tree', async () => {
    // A TanStack Start / Nitro build regenerates files that live *in* source
    // (routeTree.gen.ts) and drops temp files at the repo root. Those are
    // indistinguishable from a developer edit by path, so path ignores cannot
    // stop the feedback loop — only knowing when we build can.
    const events: string[] = [];
    mockedExeca.mockImplementation(((bin: string) => {
      events.push(`exec:${bin}`);
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    }) as never);

    const config = makeConfig();
    const sync = new HotSync(
      config,
      config.apps[0],
      healthyExecutor(),
      '/local/project',
      new HealthCheckService(healthyExecutor(), config),
      {
        buildLocation: 'local',
        healthProbe: { retries: 1, timeoutSeconds: 1, backoff: { initialMs: 1, maxMs: 1 } },
        suppressWatch: {
          pause: () => events.push('pause'),
          resume: () => events.push('resume'),
        },
      },
    );

    await sync.run(['src/index.ts']);

    // The build runs strictly inside a pause/resume bracket.
    expect(events.slice(0, 3)).toEqual(['pause', 'exec:npm', 'resume']);
  });

  it('resumes watching even when the build fails', async () => {
    const events: string[] = [];
    mockedExeca.mockImplementation((() =>
      Promise.reject(new Error('vite build failed'))) as never);

    const config = makeConfig();
    const sync = new HotSync(
      config,
      config.apps[0],
      healthyExecutor(),
      '/local/project',
      new HealthCheckService(healthyExecutor(), config),
      {
        buildLocation: 'local',
        suppressWatch: {
          pause: () => events.push('pause'),
          resume: () => events.push('resume'),
        },
      },
    );

    // A broken build is routine during development; the watcher must come back
    // or the session goes deaf until restart.
    await expect(sync.run(['src/index.ts'])).rejects.toThrow('vite build failed');
    expect(events).toEqual(['pause', 'resume']);
  });
});

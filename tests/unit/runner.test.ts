import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runRemoteCommand, runRemoteCommandForTargets, runLocalCommand } from '../../src/cli/runner.js';
import type { ShipnodeConfig } from '../../src/shared/types.js';

const mocks = vi.hoisted(() => ({
  /** Every `connect()` in call order, so tests can assert traversal order. */
  connected: [] as string[],
  /** Hosts whose connection is still open — must be empty once a run returns. */
  open: new Set<string>(),
  config: undefined as unknown as ShipnodeConfig,
}));

vi.mock('../../src/infrastructure/ssh/connection.js', () => {
  return {
    SshConnection: class MockSshConnection {
      private host = '';
      async connect(cfg?: { host: string }) {
        this.host = cfg?.host ?? '';
        mocks.connected.push(this.host);
        mocks.open.add(this.host);
      }
      disconnect() {
        mocks.open.delete(this.host);
      }
      async exec(_command: string) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
    },
  };
});

vi.mock('../../src/config/loader.js', () => {
  return {
    loadConfig: vi.fn(async () => mocks.config),
  };
});

const baseApp = {
  appType: 'backend' as const,
  healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 3, startupDelay: 3 },
  envFile: '.env',
  keepReleases: 5,
  zeroDowntime: false,
  blueGreenRetention: 'rollback' as const,
};

function workspace(): ShipnodeConfig {
  return {
    ssh: { host: 'edge.example', user: 'deploy', port: 22 },
    servers: {
      edge: { host: 'edge.example', user: 'deploy', port: 22 },
      data: { host: 'data.example', user: 'deploy', port: 22 },
      spare: { host: 'spare.example', user: 'deploy', port: 22 },
    },
    remotePath: '/var/www/app',
    nodeVersion: 'lts',
    apps: [
      { ...baseApp, name: 'api', on: 'edge' },
      { ...baseApp, name: 'worker', on: 'data' },
    ],
  } as ShipnodeConfig;
}

beforeEach(() => {
  mocks.connected.length = 0;
  mocks.open.clear();
  mocks.config = {
    ...workspace(),
    servers: { default: { host: '1.2.3.4', user: 'deploy', port: 22 } },
    ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
    apps: [{ ...baseApp, name: 'api' }],
  } as ShipnodeConfig;
});

describe('runRemoteCommand', () => {
  it('executes the command with a connected executor', async () => {
    const command = vi.fn(async ({ executor }: { executor: { exec: Function } }) => {
      await executor.exec('test');
    });

    await runRemoteCommand('/test', command);

    expect(command).toHaveBeenCalledTimes(1);
    const ctx = command.mock.calls[0][0];
    expect(ctx.config).toBeDefined();
    expect(ctx.executor).toBeDefined();
  });

  it('exits on command failure', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const command = vi.fn(async () => {
      throw new Error('Deployment failed');
    });

    await runRemoteCommand('/test', command);

    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('runRemoteCommandForTargets', () => {
  it('visits each server holding apps, in declaration order', async () => {
    mocks.config = workspace();
    const seen: string[] = [];

    await runRemoteCommandForTargets('/test', async ({ serverName }) => {
      seen.push(serverName);
    });

    expect(seen).toEqual(['edge', 'data']);
    expect(mocks.connected).toEqual(['edge.example', 'data.example']);
  });

  it('scopes each visit to that server\'s own apps', async () => {
    mocks.config = workspace();
    const byServer: Record<string, string[]> = {};

    await runRemoteCommandForTargets('/test', async ({ config, serverName }) => {
      byServer[serverName] = config.apps.map((app) => app.name);
    });

    expect(byServer).toEqual({ edge: ['api'], data: ['worker'] });
  });

  it('skips servers with nothing on them unless includeEmpty is set', async () => {
    mocks.config = workspace();

    const visited: string[] = [];
    await runRemoteCommandForTargets('/test', async ({ serverName }) => {
      visited.push(serverName);
    });
    expect(visited).not.toContain('spare');

    mocks.connected.length = 0;
    const all: string[] = [];
    await runRemoteCommandForTargets(
      '/test',
      async ({ serverName }) => {
        all.push(serverName);
      },
      { includeEmpty: true },
    );
    expect(all).toEqual(['edge', 'data', 'spare']);
  });

  it('closes every connection it opens', async () => {
    mocks.config = workspace();

    await runRemoteCommandForTargets('/test', async () => {});

    expect(mocks.connected).toHaveLength(2);
    expect(mocks.open.size).toBe(0);
  });

  it('rejects an unknown --app before connecting anywhere', async () => {
    mocks.config = workspace();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runRemoteCommandForTargets('/test', async () => {}, { appName: 'nope' });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mocks.connected).toEqual([]);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('abandons the remaining servers when one fails', async () => {
    // Documents today's behaviour: the try/catch sits outside the loop, so a
    // failure on `edge` means `data` is never visited and the user gets no
    // account of what did or did not happen. Phase 1 replaces this with
    // per-server isolation plus a summary — this test should change with it.
    mocks.config = workspace();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const visited: string[] = [];

    await runRemoteCommandForTargets('/test', async ({ serverName }) => {
      visited.push(serverName);
      if (serverName === 'edge') throw new Error('edge blew up');
    });

    expect(visited).toEqual(['edge']);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mocks.open.size).toBe(0);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('runLocalCommand', () => {
  it('executes the command without SSH connection', async () => {
    const command = vi.fn(async (config: ShipnodeConfig) => {
      expect(config.apps[0].name).toBe('api');
    });

    await runLocalCommand('/test', command);

    expect(command).toHaveBeenCalledTimes(1);
    expect(mocks.connected).toEqual([]);
  });

  it('exits on command failure', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const command = vi.fn(async () => {
      throw new Error('Local command failed');
    });

    await runLocalCommand('/test', command);

    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

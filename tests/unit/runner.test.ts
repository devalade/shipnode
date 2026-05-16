import { describe, it, expect, vi } from 'vitest';
import { runRemoteCommand, runLocalCommand } from '../../src/cli/runner.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import type { ShipnodeConfig } from '../../src/shared/types.js';

vi.mock('../../src/infrastructure/ssh/connection.js', () => {
  return {
    SshConnection: class MockSshConnection {
      connected = false;
      async connect() {
        this.connected = true;
      }
      disconnect() {
        this.connected = false;
      }
      async exec(command: string) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
    },
  };
});

vi.mock('../../src/config/loader.js', () => {
  return {
    loadConfig: vi.fn(async () => ({
      app: 'backend',
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      remotePath: '/var/www/app',
      zeroDowntime: true,
      keepReleases: 5,
      healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 3, startupDelay: 3 },
      envFile: '.env',
      nodeVersion: 'lts',
    } as ShipnodeConfig)),
  };
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

describe('runLocalCommand', () => {
  it('executes the command without SSH connection', async () => {
    const command = vi.fn(async (config: ShipnodeConfig) => {
      expect(config.app).toBe('backend');
    });

    await runLocalCommand('/test', command);

    expect(command).toHaveBeenCalledTimes(1);
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

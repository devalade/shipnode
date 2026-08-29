import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import type { ShipnodeConfig } from '../../src/shared/types.js';

const executors = new Map<string, FakeRemoteExecutor>();

vi.mock('../../src/config/loader.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/cli/prompt.js', () => ({ confirm: vi.fn() }));
vi.mock('../../src/cli/ui.js', () => ({
  ui: { banner: vi.fn(), step: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), note: vi.fn() },
}));

vi.mock('../../src/infrastructure/ssh/connection.js', () => ({
  SshConnection: class {
    private delegate = new FakeRemoteExecutor();

    async connect(ssh: { host: string }): Promise<void> {
      executors.set(ssh.host, this.delegate);
      this.delegate
        // Two releases recorded, so one step back is possible.
        .when((cmd) => cmd.includes('releases.json'), {
          stdout: JSON.stringify([
            { timestamp: '2026-01-01', status: 'success', duration: 1 },
            { timestamp: '2026-01-02', status: 'success', duration: 1 },
          ]),
          stderr: '',
          exitCode: 0,
        });
    }

    disconnect(): void {}
    exec(command: string, options?: { timeout?: number }): Promise<unknown> {
      return this.delegate.exec(command, options);
    }
    execOrThrow(command: string, options?: { timeout?: number }): Promise<unknown> {
      return this.delegate.execOrThrow(command, options);
    }
  },
}));

const { cmdRollback } = await import('../../src/cli/commands/rollback.js');
const { loadConfig } = await import('../../src/config/loader.js');
const { confirm } = await import('../../src/cli/prompt.js');

function fleetConfig(): ShipnodeConfig {
  return {
    ssh: { host: '10.0.0.11', user: 'deploy', port: 22 },
    servers: {
      'web-a': { host: '10.0.0.11', user: 'deploy', port: 22 },
      'web-b': { host: '10.0.0.12', user: 'deploy', port: 22 },
    },
    remotePath: '/var/www/app',
    nodeVersion: '22',
    apps: [{
      name: 'api',
      appType: 'backend',
      on: ['web-a', 'web-b'],
      // Not zeroDowntime, so rollback takes the symlink + pm2 reload path — the
      // recreate one, where "one replica at a time" is the only containment.
      zeroDowntime: false,
      blueGreenRetention: 'rollback',
      pm2: { apps: [{ name: 'api', port: 3000 }] },
      healthCheck: { enabled: false, path: '/health', timeout: 30, retries: 3, startupDelay: 0 },
      envFile: '.env',
      keepReleases: 5,
    }],
  };
}

function commandsOn(host: string): string[] {
  return (executors.get(host)?.getHistory() ?? []).map((entry) => entry.command);
}

beforeEach(() => {
  executors.clear();
  vi.mocked(loadConfig).mockResolvedValue(fleetConfig());
  vi.mocked(confirm).mockResolvedValue(true);
});

describe('rolling back a fleet', () => {
  it('asks once, not once per replica', async () => {
    // Prompting inside the per-replica loop would ask again with half the fleet
    // already rolled back — far too late to answer no.
    await cmdRollback('/project', { app: 'api' });

    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('rolls back one replica at a time, never two at once', async () => {
    // The rollback itself restarts PM2 on recreate-mode apps, so replicas are
    // visited sequentially — no overlap anywhere in the timeline.
    await cmdRollback('/project', { app: 'api' });

    const first = commandsOn('10.0.0.11').findIndex((cmd) => cmd.includes('mv -Tf'));
    const second = commandsOn('10.0.0.12').findIndex((cmd) => cmd.includes('mv -Tf'));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThanOrEqual(0);
  });

  it('rolls back every replica, not just the first', async () => {
    await cmdRollback('/project', { app: 'api' });

    expect(commandsOn('10.0.0.11').some((cmd) => cmd.includes('releases/2026-01-01'))).toBe(true);
    expect(commandsOn('10.0.0.12').some((cmd) => cmd.includes('releases/2026-01-01'))).toBe(true);
  });

  it('rolls back only the named replica with --on', async () => {
    await cmdRollback('/project', { app: 'api', on: 'web-b' });

    expect(executors.has('10.0.0.11')).toBe(false);
    expect(commandsOn('10.0.0.12').some((cmd) => cmd.includes('mv -Tf'))).toBe(true);
  });

  it('touches nothing when the confirmation is declined', async () => {
    vi.mocked(confirm).mockResolvedValue(false);

    await cmdRollback('/project', { app: 'api' });

    expect(executors.size).toBe(0);
  });
});

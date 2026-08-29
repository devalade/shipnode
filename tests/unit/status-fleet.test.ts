import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import type { ShipnodeConfig } from '../../src/shared/types.js';

/** Per-host canned responses, so each replica can report a different release. */
const releaseByHost = new Map<string, string | null>();

vi.mock('../../src/config/loader.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/cli/ui.js', () => ({
  ui: {
    heading: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    success: vi.fn(), section: vi.fn(), note: vi.fn(), banner: vi.fn(), step: vi.fn(), outro: vi.fn(),
  },
}));

vi.mock('../../src/infrastructure/ssh/connection.js', () => ({
  SshConnection: class {
    private delegate = new FakeRemoteExecutor();

    async connect(ssh: { host: string }): Promise<void> {
      const release = releaseByHost.get(ssh.host) ?? null;
      this.delegate
        .when((cmd) => cmd.includes('pm2 jlist'), { stdout: '[]', stderr: '', exitCode: 0 })
        .when((cmd) => cmd.includes('readlink'), {
          stdout: release === null ? 'no current symlink' : `/var/www/app/api/releases/${release}`,
          stderr: '',
          exitCode: 0,
        })
        .when((cmd) => cmd.includes('ls -1t'), { stdout: '', stderr: '', exitCode: 0 });
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

const { cmdStatus } = await import('../../src/cli/commands/status.js');
const { loadConfig } = await import('../../src/config/loader.js');
const { ui } = await import('../../src/cli/ui.js');

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
      zeroDowntime: false,
      blueGreenRetention: 'rollback',
      pm2: { apps: [{ name: 'api', port: 3000 }] },
      healthCheck: { enabled: false, path: '/health', timeout: 30, retries: 3, startupDelay: 0 },
      envFile: '.env',
      keepReleases: 5,
    }],
  };
}

const warnings = (): string => vi.mocked(ui.warn).mock.calls.map((c) => String(c[0])).join('\n');
const successes = (): string => vi.mocked(ui.success).mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  releaseByHost.clear();
  vi.mocked(loadConfig).mockResolvedValue(fleetConfig());
});

describe('status across a fleet', () => {
  it('confirms convergence when every replica is on the same release', async () => {
    releaseByHost.set('10.0.0.11', '2026-01-02');
    releaseByHost.set('10.0.0.12', '2026-01-02');

    await cmdStatus('/project', {});

    expect(successes()).toContain('All 2 replicas on 2026-01-02');
  });

  it('flags release skew, which is the sign a roll died halfway', async () => {
    releaseByHost.set('10.0.0.11', '2026-01-02');
    releaseByHost.set('10.0.0.12', '2026-01-01');

    await cmdStatus('/project', {});

    const output = warnings();
    expect(output).toContain('2 different releases');
    expect(output).toContain('2026-01-02 on web-a');
    expect(output).toContain('2026-01-01 on web-b');
  });

  it('flags a replica with no release at all', async () => {
    // A replica that was never deployed — or whose releases were wiped — is as
    // much a failure to converge as two different releases.
    releaseByHost.set('10.0.0.11', '2026-01-02');
    releaseByHost.set('10.0.0.12', null);

    await cmdStatus('/project', {});

    expect(warnings()).toContain('no release on web-b');
  });

  it('says nothing about convergence when --on narrowed the run to one replica', async () => {
    // One observation proves nothing about the others, and claiming the fleet
    // converged from it would be worse than staying quiet.
    releaseByHost.set('10.0.0.11', '2026-01-02');

    await cmdStatus('/project', { on: 'web-a' });

    expect(successes()).not.toContain('replicas on');
    expect(warnings()).not.toContain('different releases');
  });
});

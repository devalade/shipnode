import { describe, it, expect } from 'vitest';
import { ReleaseManager } from '../../src/domain/release/manager.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import type { ReleaseRecord } from '../../src/shared/types.js';

function makeRelease(timestamp: string, status: 'success' | 'failed' = 'success'): ReleaseRecord {
  return { timestamp, status, duration: 10 };
}

describe('rollback — ReleaseManager', () => {
  it('listReleases returns parsed records', async () => {
    const executor = new FakeRemoteExecutor();
    const records = [makeRelease('2025-01-01'), makeRelease('2025-01-02')];

    executor.when(
      (cmd) => cmd.includes('cat') && cmd.includes('releases.json'),
      { stdout: JSON.stringify(records), exitCode: 0 },
    );

    const manager = new ReleaseManager(executor, '/var/www/app', 5);
    const result = await manager.listReleases();

    expect(result).toHaveLength(2);
    expect(result[0].timestamp).toBe('2025-01-01');
    expect(result[1].timestamp).toBe('2025-01-02');
  });

  it('listReleases returns empty array when file missing', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(
      (cmd) => cmd.includes('cat') && cmd.includes('releases.json'),
      { stdout: '[]', exitCode: 0 },
    );

    const manager = new ReleaseManager(executor, '/var/www/app', 5);
    const result = await manager.listReleases();
    expect(result).toHaveLength(0);
  });

  it('switchSymlink issues atomic mv command', async () => {
    const executor = new FakeRemoteExecutor();
    executor
      .when((cmd) => cmd.includes('ln -sfn'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('mv -Tf'), { stdout: '', exitCode: 0 });

    const manager = new ReleaseManager(executor, '/var/www/app', 5);
    await manager.switchSymlink('/var/www/app/releases/2025-01-01');

    const history = executor.getHistory();
    expect(history.some((h) => h.command.includes('ln -sfn'))).toBe(true);
    expect(history.some((h) => h.command.includes('mv -Tf'))).toBe(true);
  });

  it('getCurrentReleasePath returns readlink target', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(
      (cmd) => cmd.includes('readlink') && cmd.includes('/current'),
      { stdout: '/var/www/app/releases/2025-01-01\n', exitCode: 0 },
    );

    const manager = new ReleaseManager(executor, '/var/www/app', 5);
    await expect(manager.getCurrentReleasePath()).resolves.toBe('/var/www/app/releases/2025-01-01');
  });

  it('getCurrentReleasePath returns null when current is missing', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(
      (cmd) => cmd.includes('readlink'),
      { stdout: '', exitCode: 0 },
    );

    const manager = new ReleaseManager(executor, '/var/www/app', 5);
    await expect(manager.getCurrentReleasePath()).resolves.toBeNull();
  });

  it('recordRelease uses base64 to avoid shell quoting limits', async () => {
    const executor = new FakeRemoteExecutor();
    executor
      .when((cmd) => cmd.includes('cat') && cmd.includes('releases.json'), { stdout: '[]', exitCode: 0 })
      .when((cmd) => cmd.includes('base64'), { stdout: '', exitCode: 0 });

    const manager = new ReleaseManager(executor, '/var/www/app', 5);
    await manager.recordRelease(makeRelease('2025-01-01'));

    const history = executor.getHistory();
    const writeCmd = history.find((h) => h.command.includes('base64'));
    expect(writeCmd).toBeDefined();
    expect(writeCmd!.command).toContain('releases.json');
  });
});

import { describe, it, expect } from 'vitest';
import { DeployLock } from '../../src/domain/release/manager.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import { LockError } from '../../src/shared/errors.js';

describe('DeployLock', () => {
  it('acquires lock when no lock file exists', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(
      (cmd) => cmd.includes('deploy.lock'),
      { stdout: 'OK', exitCode: 0 },
    );

    const lock = new DeployLock(executor, '/var/www/app');
    await expect(lock.acquire()).resolves.toBeUndefined();
  });

  it('throws LockError when lock is held (age < 3600s)', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(
      (cmd) => cmd.includes('deploy.lock'),
      { stdout: 'LOCKED:120', exitCode: 1 },
    );

    const lock = new DeployLock(executor, '/var/www/app');
    await expect(lock.acquire()).rejects.toThrow(LockError);
    await expect(lock.acquire()).rejects.toThrow('120s');
  });

  it('LockError message references unlock command', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(
      (cmd) => cmd.includes('deploy.lock'),
      { stdout: 'LOCKED:60', exitCode: 1 },
    );

    const lock = new DeployLock(executor, '/var/www/app');
    try {
      await lock.acquire();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LockError);
      expect((err as Error).message).toContain('shipnode unlock');
    }
  });

  it('releases lock by removing the lock directory', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(
      (cmd) => cmd.includes('rm -rf') && cmd.includes('deploy.lock'),
      { stdout: '', exitCode: 0 },
    );

    const lock = new DeployLock(executor, '/var/www/app');
    await lock.release();

    const history = executor.getHistory();
    expect(history.some((h) => h.command.includes('rm -rf') && h.command.includes('deploy.lock'))).toBe(true);
  });

  it('stale lock (age >= 3600s) is cleared automatically on acquire', async () => {
    const executor = new FakeRemoteExecutor();
    // Stale lock → command removes it and returns OK
    executor.when(
      (cmd) => cmd.includes('deploy.lock'),
      { stdout: 'OK', exitCode: 0 },
    );

    const lock = new DeployLock(executor, '/var/www/app');
    await expect(lock.acquire()).resolves.toBeUndefined();
  });
});

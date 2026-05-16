import { describe, it, expect } from 'vitest';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';

describe('FakeRemoteExecutor', () => {
  it('returns default result when no matcher is registered', async () => {
    const executor = new FakeRemoteExecutor();
    const result = await executor.exec('echo hello');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('returns matched result for registered predicate', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(
      (cmd) => cmd.includes('node --version'),
      { stdout: 'v20.0.0', stderr: '', exitCode: 0 },
    );

    const result = await executor.exec('node --version');
    expect(result.stdout).toBe('v20.0.0');
  });

  it('uses the first matching predicate', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(
      (cmd) => cmd.includes('test'),
      { stdout: 'first', stderr: '', exitCode: 0 },
    );
    executor.when(
      (cmd) => cmd.includes('test'),
      { stdout: 'second', stderr: '', exitCode: 0 },
    );

    const result = await executor.exec('test');
    expect(result.stdout).toBe('first');
  });

  it('records command history', async () => {
    const executor = new FakeRemoteExecutor();
    await executor.exec('ls -la', { timeout: 5000 });
    await executor.exec('pwd');

    const history = executor.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].command).toBe('ls -la');
    expect(history[0].options).toEqual({ timeout: 5000 });
    expect(history[1].command).toBe('pwd');
    expect(history[1].options).toBeUndefined();
  });

  it('returns the last command', async () => {
    const executor = new FakeRemoteExecutor();
    await executor.exec('first');
    await executor.exec('second');

    expect(executor.getLastCommand()?.command).toBe('second');
  });

  it('clears history and matchers', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when((cmd) => cmd === 'test', { stdout: 'ok', stderr: '', exitCode: 0 });
    await executor.exec('test');
    executor.clear();

    expect(executor.getHistory()).toHaveLength(0);
    const result = await executor.exec('test');
    expect(result.stdout).toBe(''); // default result after clear
  });
});

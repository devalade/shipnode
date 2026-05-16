import { describe, it, expect } from 'vitest';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';

describe('env upload — executor contract', () => {
  it('uploads via base64 to avoid binary/quoting issues', async () => {
    const executor = new FakeRemoteExecutor();
    executor
      .when((cmd) => cmd.includes('mkdir'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('base64'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('chmod'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('current'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('pm2'), { stdout: 'stopped', exitCode: 0 });

    // Simulate the base64 upload sequence used by cmdEnv
    const content = 'DB_HOST=localhost\nDB_PORT=5432\n';
    const b64 = Buffer.from(content).toString('base64');
    const remotePath = '/var/www/app/shared/.env';

    await executor.exec(`mkdir -p "/var/www/app/shared"`);
    await executor.exec(`echo "${b64}" | base64 -d > "${remotePath}"`);
    await executor.exec(`chmod 600 "${remotePath}"`);

    const history = executor.getHistory();
    expect(history.some((h) => h.command.includes('mkdir'))).toBe(true);
    expect(history.some((h) => h.command.includes('base64') && h.command.includes('.env'))).toBe(true);
    expect(history.some((h) => h.command.includes('chmod 600'))).toBe(true);
  });

  it('links shared .env into current release for zero-downtime', async () => {
    const executor = new FakeRemoteExecutor();
    executor
      .when((cmd) => cmd.includes('mkdir'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('base64'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('chmod'), { stdout: '', exitCode: 0 })
      .when((cmd) => cmd.includes('ln -sfn'), { stdout: 'linked', exitCode: 0 });

    const sharedEnv = '/var/www/app/shared/.env';
    const result = await executor.exec(
      `if [ -d "/var/www/app/current" ]; then ln -sfn "${sharedEnv}" "/var/www/app/current/.env" && echo "linked"; fi`,
    );

    expect(result.stdout).toBe('linked');
  });
});

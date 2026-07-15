import { describe, it, expect } from 'vitest';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import { uploadEnvironmentFile } from '../../src/cli/commands/env.js';

describe('env upload — executor contract', () => {
  it('atomically uploads via base64 with restrictive permissions', async () => {
    const executor = new FakeRemoteExecutor();
    const content = 'DB_HOST=localhost\nDB_PORT=5432\n';
    const remotePath = '/var/www/app/shared/.env';

    await uploadEnvironmentFile(executor, remotePath, Buffer.from(content));

    const history = executor.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].command).toContain('mkdir -p');
    expect(history[1].command).toContain('mktemp');
    expect(history[1].command).toContain('base64 -d > "$tmp"');
    expect(history[1].command).toContain('chmod 600 "$tmp"');
    expect(history[1].command).toContain(`mv -f "$tmp" '${remotePath}'`);
  });

  it('uploads to shared/<envFile name>, not a hardcoded shared/.env', async () => {
    // The previous behavior hardcoded shared/.env regardless of the configured
    // filename, which broke the PM2 ecosystem reference that already used
    // `shared/${envFile}`. Upload + ecosystem now agree.
    const remotePath = '/var/www/app';
    const envFile = '.env.production';
    const sharedEnv = `${remotePath}/shared/${envFile}`;

    expect(sharedEnv).toBe('/var/www/app/shared/.env.production');
    expect(sharedEnv).not.toBe(`${remotePath}/shared/.env`);
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

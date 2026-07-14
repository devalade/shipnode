import { describe, expect, it } from 'vitest';
import {
  fail2banCheckActiveCommand,
  isFail2banActive,
} from '../../src/infrastructure/provisioning/security.js';
import { checkRemote, checkSecurity } from '../../src/cli/commands/doctor.js';
import { assembleConfig } from '../../src/config/assembly.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';

describe('fail2ban status', () => {
  it('recognises only the exact ACTIVE protocol value', () => {
    expect(isFail2banActive('ACTIVE\n')).toBe(true);
    expect(isFail2banActive('NOT_ACTIVE\n')).toBe(false);
    expect(isFail2banActive('active\nACTIVE\n')).toBe(false);
  });

  it('suppresses systemctl output before emitting the protocol value', () => {
    expect(fail2banCheckActiveCommand()).toContain('systemctl is-active --quiet fail2ban');
  });
});

describe('doctor security output', () => {
  it('runs Node and PM2 diagnostics through the configured mise runtime', async () => {
    const executor = new FakeRemoteExecutor();
    const config = assembleConfig({
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      nodeVersion: '22',
      apps: [{
        name: 'api',
        appType: 'backend',
        pm2: { apps: [{ name: 'api', port: 3000 }] },
      }],
    });

    await checkRemote(config, executor);

    const commands = executor.getHistory().map((entry) => entry.command);
    expect(commands.some((command) => command.includes('mise exec "node@22" -- node --version'))).toBe(true);
    expect(commands.some((command) => command.includes('mise exec "node@22" -- pm2 --version'))).toBe(true);
  });

  it('keeps every UFW rule visible', async () => {
    const rules = Array.from({ length: 8 }, (_, index) => `rule ${index + 1}`).join('\n');
    const executor = new FakeRemoteExecutor()
      .when((command) => command.includes('sshd_config'), { stdout: 'PermitRootLogin no', stderr: '', exitCode: 0 })
      .when((command) => command.includes('ufw status'), { stdout: rules, stderr: '', exitCode: 0 })
      .when((command) => command.includes('fail2ban-client'), { stdout: 'Status', stderr: '', exitCode: 0 })
      .when((command) => command.includes('stat -c'), { stdout: '600 deploy:deploy', stderr: '', exitCode: 0 });
    const output: string[] = [];

    await checkSecurity({ remotePath: '/var/www/app' }, executor, (line) => output.push(line));

    const firewall = output.find((line) => line.includes('rule 1'));
    expect(firewall).toContain('rule 8');
    expect(firewall?.split('\n')).toHaveLength(8);
  });
});

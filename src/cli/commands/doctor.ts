import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';
import { getActiveApp } from '../../domain/workspace.js';
import type { ShipnodeConfig } from '../../shared/types.js';

export async function cmdDoctor(cwd: string, options: { config?: string; security?: boolean }): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      ui.heading('ShipNode Doctor');

      await checkLocal(config);

      if (!options.security) {
        await checkRemote(config, executor);
      } else {
        await checkSecurity(config, executor);
      }
    },
    { configPath: options.config },
  );
}

function checkLocal(config: ShipnodeConfig): void {
  const app = getActiveApp(config);
  ui.info('Checking local configuration...');

  const issues: string[] = [];

  if (!config.ssh.host) {
    issues.push('SSH host is not configured');
  }

  if (!config.ssh.user) {
    issues.push('SSH user is not configured');
  }

  if (!config.remotePath) {
    issues.push('Remote path is not configured');
  }

  if (app.appType === 'backend' && !app.pm2?.apps.length) {
    issues.push('PM2 apps are not configured for backend app');
  }

  if (issues.length === 0) {
    ui.success('Local configuration looks good');
  } else {
    for (const issue of issues) {
      ui.warn(issue);
    }
  }
}

async function checkRemote(
  config: { ssh: { host: string; user: string }; remotePath: string },
  executor: { exec: (cmd: string, opts?: { timeout?: number }) => Promise<{ stdout: string; exitCode: number }> },
): Promise<void> {
  ui.info('Checking remote server...');

  const checks = [
    { name: 'Node', cmd: 'node --version' },
    { name: 'PM2', cmd: 'pm2 --version' },
    { name: 'Caddy', cmd: 'caddy version' },
    { name: 'rsync', cmd: 'rsync --version' },
    { name: 'jq', cmd: 'jq --version' },
  ];

  for (const check of checks) {
    try {
      const result = await executor.exec(check.cmd, { timeout: 5000 });
      if (result.exitCode === 0) {
        ui.success(`${check.name}: ${result.stdout.split('\n')[0]}`);
      } else {
        ui.warn(`${check.name}: not installed`);
      }
    } catch {
      ui.warn(`${check.name}: not installed`);
    }
  }

  ui.info('Checking deployment directory...');
  const dirResult = await executor.exec(`test -d "${config.remotePath}" && echo "exists" || echo "missing"`);
  if (dirResult.stdout === 'exists') {
    ui.success(`Deployment directory exists: ${config.remotePath}`);
  } else {
    ui.warn(`Deployment directory does not exist. Run 'shipnode setup' first.`);
  }
}

async function checkSecurity(
  config: { remotePath: string },
  executor: { exec: (cmd: string) => Promise<{ stdout: string }> },
): Promise<void> {
  ui.info('Running security audit...');

  const sshdResult = await executor.exec(
    'sudo grep -E "^(PermitRootLogin|PasswordAuthentication|Port)" /etc/ssh/sshd_config 2>/dev/null || echo "not found"',
  );
  ui.info('SSH Configuration:');
  console.log(`  ${sshdResult.stdout.replace(/\n/g, '\n  ')}`);

  const firewallResult = await executor.exec(
    'sudo ufw status 2>/dev/null || sudo iptables -L -n 2>/dev/null || echo "no firewall detected"',
  );
  ui.info('Firewall Status:');
  console.log(`  ${firewallResult.stdout.split('\n').slice(0, 5).join('\n  ')}`);

  const fail2banResult = await executor.exec('sudo fail2ban-client status 2>/dev/null || echo "fail2ban not installed"');
  ui.info('Fail2ban:');
  console.log(`  ${fail2banResult.stdout.split('\n')[0]}`);

  const permResult = await executor.exec(`stat -c "%a %U:%G" "${config.remotePath}/shared/.env" 2>/dev/null || echo "no .env found"`);
  ui.info('Env file permissions:');
  console.log(`  ${permResult.stdout}`);
}

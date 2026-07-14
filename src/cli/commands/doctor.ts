import { runRemoteCommandForTargets } from '../runner.js';
import { ui } from '../ui.js';
import type { ShipnodeConfig } from '../../shared/types.js';

export async function cmdDoctor(cwd: string, options: { config?: string; security?: boolean }): Promise<void> {
  await runRemoteCommandForTargets(
    cwd,
    async ({ config, executor, serverName }) => {
      ui.heading('ShipNode Doctor');
      ui.heading(`Server: ${serverName} (${config.ssh.user}@${config.ssh.host})`);

      await checkLocal(config);

      if (!options.security) {
        await checkRemote(config, executor);
      } else {
        await checkSecurity(config, executor);
      }
    },
    { configPath: options.config, includeEmpty: true },
  );
}

function checkLocal(config: ShipnodeConfig): void {
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

  if (config.apps.some((app) => app.appType === 'backend' && !app.pm2?.apps.length)) {
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

/** Run remote dependency diagnostics through the same executor used by the CLI. */
export async function checkRemote(
  config: ShipnodeConfig,
  executor: { exec: (cmd: string, opts?: { timeout?: number }) => Promise<{ stdout: string; exitCode: number }> },
): Promise<void> {
  ui.info('Checking remote server...');

  const needsNode = config.apps.length > 0;
  const needsPm2 = config.apps.some((app) => app.appType === 'backend' && app.pm2);
  const needsCaddy = config.apps.some((app) => app.domain);
  const needsDocker = Object.keys(config.accessories ?? {}).length > 0;

  const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
  const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
  const checks = [
    ...(needsNode ? [{ name: 'Node', cmd: `${mise}; mise exec "node@${nodeVersion}" -- node --version` }] : []),
    ...(needsPm2 ? [{ name: 'PM2', cmd: `${mise}; mise exec "node@${nodeVersion}" -- pm2 --version` }] : []),
    ...(needsCaddy ? [{ name: 'Caddy', cmd: 'caddy version' }] : []),
    ...(needsDocker ? [{ name: 'Docker', cmd: 'docker --version' }] : []),
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

  if (config.apps.length > 0) {
    ui.info('Checking deployment directory...');
    const dirResult = await executor.exec(`test -d "${config.remotePath}" && echo "exists" || echo "missing"`);
    if (dirResult.stdout === 'exists') {
      ui.success(`Deployment directory exists: ${config.remotePath}`);
    } else {
      ui.warn(`Deployment directory does not exist. Run 'shipnode setup' first.`);
    }
  }
}

/** Run the security audit and write each complete diagnostic section to `write`. */
export async function checkSecurity(
  config: { remotePath: string },
  executor: { exec: (cmd: string) => Promise<{ stdout: string }> },
  write: (output: string) => void = console.log,
): Promise<void> {
  ui.info('Running security audit...');

  const sshdResult = await executor.exec(
    'sudo grep -E "^(PermitRootLogin|PasswordAuthentication|Port)" /etc/ssh/sshd_config 2>/dev/null || echo "not found"',
  );
  ui.info('SSH Configuration:');
  write(indentDiagnosticOutput(sshdResult.stdout));

  const firewallResult = await executor.exec(
    'sudo ufw status 2>/dev/null || sudo iptables -L -n 2>/dev/null || echo "no firewall detected"',
  );
  ui.info('Firewall Status:');
  write(indentDiagnosticOutput(firewallResult.stdout));

  const fail2banResult = await executor.exec('sudo fail2ban-client status 2>/dev/null || echo "fail2ban not installed"');
  ui.info('Fail2ban:');
  write(`  ${fail2banResult.stdout.split('\n')[0]}`);

  const permResult = await executor.exec(`stat -c "%a %U:%G" "${config.remotePath}/shared/.env" 2>/dev/null || echo "no .env found"`);
  ui.info('Env file permissions:');
  write(`  ${permResult.stdout}`);
}

function indentDiagnosticOutput(output: string): string {
  return `  ${output.replace(/\n/g, '\n  ')}`;
}

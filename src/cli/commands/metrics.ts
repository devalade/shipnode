import { execa } from 'execa';
import { loadConfig } from '../../config/loader.js';
import { getActiveApp } from '../../domain/workspace.js';
import { getDeploymentName } from '../../domain/pm2/apps.js';
import { getServerTargetResult } from '../../domain/servers.js';
import { ui } from '../ui.js';

export async function cmdMetrics(cwd: string, options: { config?: string; app?: string }): Promise<void> {
  const config = await loadConfig(cwd, options.config);
  const app = options.app ? getActiveApp(config, options.app) : config.apps[0];
  const target = getServerTargetResult(config, app.on);
  if (target.isErr()) {
    ui.error(target.error.message);
    process.exit(1);
    return;
  }

  if (app.appType !== 'backend' || !getDeploymentName({ ...config, apps: [app] } as any)) {
    throw new Error('Metrics only available for backend apps with PM2');
  }

  const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
  const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
  const remoteCmd = `${mise}; mise exec "node@${nodeVersion}" -- pm2 monit`;

  const sshArgs = [
    '-t',
    '-p', String(target.value.ssh.port),
    ...(target.value.ssh.identityFile ? ['-i', target.value.ssh.identityFile] : []),
    `${target.value.ssh.user}@${target.value.ssh.host}`,
    remoteCmd,
  ];

  const result = await execa('ssh', sshArgs, { stdio: 'inherit', reject: false });
  process.exit(result.exitCode ?? 0);
}

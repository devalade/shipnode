import { execa } from 'execa';
import { loadConfig } from '../../config/loader.js';
import { getDeploymentName } from '../../domain/pm2/apps.js';

export async function cmdMetrics(cwd: string, options: { config?: string }): Promise<void> {
  const config = await loadConfig(cwd, options.config);
  if (config.app !== 'backend' || !getDeploymentName(config)) {
    throw new Error('Metrics only available for backend apps with PM2');
  }
  const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
  const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
  const remoteCmd = `${mise}; mise exec "node@${nodeVersion}" -- pm2 monit`;

  const sshArgs = [
    '-t',
    '-p', String(config.ssh.port),
    ...(config.ssh.identityFile ? ['-i', config.ssh.identityFile] : []),
    `${config.ssh.user}@${config.ssh.host}`,
    remoteCmd,
  ];

  const result = await execa('ssh', sshArgs, { stdio: 'inherit', reject: false });
  process.exit(result.exitCode ?? 0);
}

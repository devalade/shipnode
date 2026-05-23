import { runRemoteCommand } from '../runner.js';
import { getDeploymentName, resolveProcessTarget } from '../../domain/pm2/apps.js';

export async function cmdLogs(cwd: string, options: { lines?: number; config?: string; process?: string }): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      const namespace = getDeploymentName(config);
      if (config.app !== 'backend' || !namespace) {
        throw new Error('Logs only available for backend apps with PM2');
      }
      const target = options.process ? resolveProcessTarget(config, options.process) : namespace;
      const lines = options.lines ?? 100;
      const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
      const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
      const result = await executor.exec(
        `${mise}; mise exec "node@${nodeVersion}" -- pm2 logs ${target} --lines ${lines} --nostream`,
      );
      if (result.stdout) process.stdout.write(result.stdout + '\n');
      if (result.stderr) process.stderr.write(result.stderr + '\n');
    },
    { configPath: options.config },
  );
}

import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';
import { getDeploymentName, resolveProcessTarget } from '../../domain/pm2/apps.js';

export async function cmdRestart(cwd: string, options: { config?: string; process?: string }): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      const namespace = getDeploymentName(config);
      if (config.app !== 'backend' || !namespace) {
        throw new Error('Restart only available for backend apps with PM2');
      }
      const target = options.process ? resolveProcessTarget(config, options.process) : namespace;
      const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
      const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
      await executor.exec(
        `${mise}; mise exec "node@${nodeVersion}" -- pm2 reload ${target} --update-env`,
      );
      ui.success(options.process
        ? `Process '${options.process}' restarted successfully`
        : `Deployment '${namespace}' restarted successfully`);
    },
    { configPath: options.config },
  );
}

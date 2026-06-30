import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';
import { getActiveApp } from '../../domain/workspace.js';
import { getDeploymentName, resolveProcessTarget } from '../../domain/pm2/apps.js';

export async function cmdStop(cwd: string, options: { config?: string; process?: string }): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      const namespace = getDeploymentName(config);
      if (getActiveApp(config).appType !== 'backend' || !namespace) {
        throw new Error('Stop only available for backend apps with PM2');
      }
      const target = options.process ? resolveProcessTarget(config, options.process) : namespace;
      const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
      const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
      await executor.exec(
        `${mise}; mise exec "node@${nodeVersion}" -- pm2 stop ${target}`,
      );
      ui.warn(options.process
        ? `Process '${options.process}' has been stopped`
        : `Deployment '${namespace}' has been stopped`);
    },
    { configPath: options.config },
  );
}

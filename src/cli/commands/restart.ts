import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';

export async function cmdRestart(cwd: string, options: { config?: string }): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      if (config.app !== 'backend' || !config.pm2?.name) {
        throw new Error('Restart only available for backend apps with PM2');
      }
      const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
      const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
      await executor.exec(
        `${mise}; mise exec "node@${nodeVersion}" -- pm2 reload ${config.pm2.name} --update-env`,
      );
      ui.success(`App '${config.pm2.name}' restarted successfully`);
    },
    { configPath: options.config },
  );
}

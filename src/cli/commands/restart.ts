import { runRemoteCommandForTargets } from '../runner.js';
import { ui } from '../ui.js';

export async function cmdRestart(cwd: string, options: { config?: string; process?: string; app?: string; on?: string }): Promise<void> {
  await runRemoteCommandForTargets(
    cwd,
    async ({ config, executor }) => {
      const apps = options.app
        ? config.apps.filter((app) => app.name === options.app)
        : config.apps.filter((a) => a.appType === 'backend' && a.pm2);

      if (options.app && apps.length === 0) return;

      if (apps.length === 0) {
        if (options.app) return;
        throw new Error('No backend apps with PM2 configured');
      }

      if (options.process && apps.length > 1) {
        throw new Error('--process requires --app to target a specific app');
      }

      const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
      const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;

      for (const app of apps) {
        const namespace = app.pm2!.apps[0].name;
        const target = options.process
          ? app.pm2!.apps.find((a) => a.name === options.process)?.name ?? namespace
          : namespace;
        await executor.exec(
          `${mise}; mise exec "node@${nodeVersion}" -- pm2 reload ${target} --update-env`,
        );
        ui.success(`App '${app.name}' restarted successfully`);
      }
    },
    { configPath: options.config, appName: options.app, serverName: options.on },
  );
}

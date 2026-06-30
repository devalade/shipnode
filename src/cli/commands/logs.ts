import { runRemoteCommand } from '../runner.js';
import { getActiveApp } from '../../domain/workspace.js';

export async function cmdLogs(cwd: string, options: { lines?: number; config?: string; process?: string; app?: string }): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      const apps = options.app
        ? [getActiveApp(config, options.app)]
        : config.apps.filter((a) => a.appType === 'backend' && a.pm2);

      if (apps.length === 0) {
        throw new Error('No backend apps with PM2 configured');
      }

      if (options.process && apps.length > 1) {
        throw new Error('--process requires --app to target a specific app');
      }

      const lines = options.lines ?? 100;
      const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
      const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;

      for (const app of apps) {
        const namespace = app.pm2!.apps[0].name;
        const target = options.process
          ? app.pm2!.apps.find((a) => a.name === options.process)?.name ?? namespace
          : namespace;
        const result = await executor.exec(
          `${mise}; mise exec "node@${nodeVersion}" -- pm2 logs ${target} --lines ${lines} --nostream`,
        );
        if (result.stdout) process.stdout.write(`[${app.name}] ${result.stdout}\n`);
        if (result.stderr) process.stderr.write(`[${app.name}] ${result.stderr}\n`);
      }
    },
    { configPath: options.config },
  );
}

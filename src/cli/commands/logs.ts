import { runRemoteCommand } from '../runner.js';

export async function cmdLogs(cwd: string, options: { lines?: number; config?: string }): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      if (config.app !== 'backend' || !config.pm2?.name) {
        throw new Error('Logs only available for backend apps with PM2');
      }
      const lines = options.lines ?? 100;
      const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
      const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
      const result = await executor.exec(
        `${mise}; mise exec "node@${nodeVersion}" -- pm2 logs ${config.pm2.name} --lines ${lines} --nostream`,
      );
      if (result.stdout) process.stdout.write(result.stdout + '\n');
      if (result.stderr) process.stderr.write(result.stderr + '\n');
    },
    { configPath: options.config },
  );
}

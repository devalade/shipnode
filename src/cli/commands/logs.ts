import { runRemoteCommandForTargets } from '../runner.js';

/**
 * Prefix every line, not every block.
 *
 * A fleet interleaves output from several servers, and a block-level prefix
 * leaves the reader guessing which box a stack trace came from once the second
 * server's output starts.
 */
function prefixLines(text: string, label: string): string {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => `${label} ${line}`)
    .join('\n');
}

export async function cmdLogs(cwd: string, options: { lines?: number; config?: string; process?: string; app?: string; on?: string }): Promise<void> {
  await runRemoteCommandForTargets(
    cwd,
    async ({ config, executor, serverName }) => {
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
        const label = `[${serverName} ${app.name}]`;
        if (result.stdout) process.stdout.write(`${prefixLines(result.stdout, label)}\n`);
        if (result.stderr) process.stderr.write(`${prefixLines(result.stderr, label)}\n`);
      }
    },
    { configPath: options.config, appName: options.app, serverName: options.on },
  );
}

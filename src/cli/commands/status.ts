import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';

export async function cmdStatus(cwd: string, options: { config?: string }): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      ui.info(`Checking status on ${config.ssh.host}...`);

      if (config.app === 'backend' && config.pm2) {
        const pm2Result = await executor.exec(
          `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH" && pm2 jlist`,
        );

        if (pm2Result.exitCode === 0) {
          try {
            const apps = JSON.parse(pm2Result.stdout);
            const myApp = apps.find((a: { name: string }) => a.name === config.pm2?.name);

            if (myApp) {
              ui.heading(`PM2: ${myApp.name}`);
              ui.section('Status', [
                ['Status', myApp.pm2_env?.status ?? 'unknown'],
                ['PID', String(myApp.pid ?? 'N/A')],
                ['Uptime', myApp.pm2_env?.pm_uptime ? new Date(myApp.pm2_env.pm_uptime).toISOString() : 'N/A'],
                ['Restarts', String(myApp.pm2_env?.restart_time ?? 0)],
                ['Memory', myApp.monit ? `${myApp.monit.memory} MB` : 'N/A'],
                ['CPU', myApp.monit ? `${myApp.monit.cpu}%` : 'N/A'],
              ]);
            } else {
              ui.warn(`App '${config.pm2.name}' not found in PM2`);
            }
          } catch {
            ui.warn('Could not parse PM2 output');
          }
        } else {
          ui.warn('PM2 is not running');
        }
      }

      const currentResult = await executor.exec(`readlink "${config.remotePath}/current" 2>/dev/null || echo "no current symlink"`);
      if (currentResult.stdout !== 'no current symlink') {
        ui.success(`Current release: ${currentResult.stdout}`);
      } else {
        ui.warn('No active release');
      }

      const releasesResult = await executor.exec(`ls -1t "${config.remotePath}/releases/" 2>/dev/null | head -5`);
      if (releasesResult.stdout) {
        const releases = releasesResult.stdout.split('\n').filter(Boolean);
        ui.section('Recent Releases', releases.map((r: string, i: number) => [`#${i + 1}`, r]));
      }
    },
    { configPath: options.config },
  );
}

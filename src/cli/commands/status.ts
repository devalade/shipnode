import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';
import { getDeploymentName, getPm2Name } from '../../domain/pm2/apps.js';

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
            const allApps = JSON.parse(pm2Result.stdout) as Array<{
              name: string;
              pid?: number;
              pm2_env?: { status?: string; pm_uptime?: number; restart_time?: number };
              monit?: { memory: number; cpu: number };
            }>;
            const declared = config.pm2.apps;
            const namespace = getDeploymentName(config) ?? '';
            const byName = new Map(allApps.map((a) => [a.name, a]));
            for (const app of declared) {
              const pm2Name = getPm2Name(namespace, app.name);
              const running = byName.get(pm2Name);
              if (!running) {
                ui.warn(`App '${app.name}' not found in PM2`);
                continue;
              }
              ui.heading(`PM2: ${app.name}`);
              ui.section('Status', [
                ['Status', running.pm2_env?.status ?? 'unknown'],
                ['PID', String(running.pid ?? 'N/A')],
                ['Uptime', running.pm2_env?.pm_uptime ? new Date(running.pm2_env.pm_uptime).toISOString() : 'N/A'],
                ['Restarts', String(running.pm2_env?.restart_time ?? 0)],
                ['Memory', running.monit ? `${running.monit.memory} MB` : 'N/A'],
                ['CPU', running.monit ? `${running.monit.cpu}%` : 'N/A'],
              ]);
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

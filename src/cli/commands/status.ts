import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';
import { getActiveApp } from '../../domain/workspace.js';
import { getDeploymentName, getPm2Name } from '../../domain/pm2/apps.js';

export async function cmdStatus(cwd: string, options: { config?: string; app?: string }): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      const apps = options.app
        ? [getActiveApp(config, options.app)]
        : config.apps;

      for (const app of apps) {
        ui.heading(`Status: ${app.name} (${app.appType})`);

        if (app.appType === 'backend' && app.pm2) {
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
              const declared = app.pm2.apps;
              const namespace = getDeploymentName(config) ?? '';
              const byName = new Map(allApps.map((a) => [a.name, a]));
              for (const pm2App of declared) {
                const pm2Name = getPm2Name(namespace, pm2App.name);
                const running = byName.get(pm2Name);
                if (!running) {
                  ui.warn(`  App '${pm2App.name}' not found in PM2`);
                  continue;
                }
                ui.heading(`  PM2: ${pm2App.name}`);
                ui.section('  Status', [
                  ['Status', running.pm2_env?.status ?? 'unknown'],
                  ['PID', String(running.pid ?? 'N/A')],
                  ['Uptime', running.pm2_env?.pm_uptime ? new Date(running.pm2_env.pm_uptime).toISOString() : 'N/A'],
                  ['Restarts', String(running.pm2_env?.restart_time ?? 0)],
                  ['Memory', running.monit ? `${running.monit.memory} MB` : 'N/A'],
                  ['CPU', running.monit ? `${running.monit.cpu}%` : 'N/A'],
                ]);
              }
            } catch {
              ui.warn('  Could not parse PM2 output');
            }
          } else {
            ui.warn('  PM2 is not running');
          }
        }

        const appPath = `${config.remotePath}/${app.name}`;
        const currentResult = await executor.exec(`readlink "${appPath}/current" 2>/dev/null || echo "no current symlink"`);
        if (currentResult.stdout !== 'no current symlink') {
          ui.success(`  Current release: ${currentResult.stdout}`);
        } else {
          ui.warn('  No active release');
        }

        const releasesResult = await executor.exec(`ls -1t "${appPath}/releases/" 2>/dev/null | head -5`);
        if (releasesResult.stdout) {
          const releases = releasesResult.stdout.split('\n').filter(Boolean);
          ui.section('  Recent Releases', releases.map((r: string, i: number) => [`#${i + 1}`, r]));
        }
      }
    },
    { configPath: options.config },
  );
}

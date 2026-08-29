import { runRemoteCommandForTargets } from '../runner.js';
import { ui } from '../ui.js';
import { getDeploymentName, getPm2Name } from '../../domain/pm2/apps.js';
import { isFleet } from '../../domain/servers.js';
import {
  assessConvergence,
  describeConvergence,
  type ReplicaObservation,
} from '../../domain/deploy/convergence.js';

export async function cmdStatus(cwd: string, options: { config?: string; app?: string; on?: string }): Promise<void> {
  // Per-app, per-replica observations, gathered as the fan-out visits each
  // server. Release skew is invisible from inside one server, so the comparison
  // happens after every replica has reported.
  const observed = new Map<string, ReplicaObservation[]>();
  const fleetApps = new Set<string>();

  await runRemoteCommandForTargets(
    cwd,
    async ({ config, executor, serverName }) => {
      const apps = options.app
        ? config.apps.filter((app) => app.name === options.app)
        : config.apps;

      if (apps.length === 0) return;
      ui.heading(`Server: ${serverName} (${config.ssh.user}@${config.ssh.host})`);

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
                  // A process pinned to the primary is absent everywhere else by
                  // design; saying "not found" would report the feature as a fault.
                  if (pm2App.placement === 'primary') {
                    ui.info(`  App '${pm2App.name}' is pinned to the primary replica — not expected here`);
                  } else {
                    ui.warn(`  App '${pm2App.name}' not found in PM2`);
                  }
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
        const hasRelease = currentResult.stdout !== 'no current symlink' && currentResult.stdout !== '';
        if (hasRelease) {
          ui.success(`  Current release: ${currentResult.stdout}`);
        } else {
          ui.warn('  No active release');
        }

        const entries = observed.get(app.name) ?? [];
        entries.push({
          server: serverName,
          // The symlink is absolute; only the release directory name is
          // comparable between replicas.
          release: hasRelease ? currentResult.stdout.split('/').pop() ?? null : null,
        });
        observed.set(app.name, entries);

        if (isFleet(config, app)) fleetApps.add(app.name);

        const releasesResult = await executor.exec(`ls -1t "${appPath}/releases/" 2>/dev/null | head -5`);
        if (releasesResult.stdout) {
          const releases = releasesResult.stdout.split('\n').filter(Boolean);
          ui.section('  Recent Releases', releases.map((r: string, i: number) => [`#${i + 1}`, r]));
        }
      }
    },
    { configPath: options.config, serverName: options.on },
  );

  reportFleetConvergence(observed, fleetApps, options.on !== undefined);
}

/**
 * The cross-replica view, which is the only place a half-rolled fleet shows up.
 *
 * Skipped when `--on` narrowed the run to one server: a single observation
 * proves nothing about the others, and reporting "converged" from it would be
 * worse than saying nothing.
 */
function reportFleetConvergence(
  observed: Map<string, ReplicaObservation[]>,
  fleetApps: Set<string>,
  narrowed: boolean,
): void {
  if (narrowed) return;

  for (const [appName, observations] of observed) {
    if (!fleetApps.has(appName) || observations.length < 2) continue;

    const convergence = assessConvergence(observations);
    ui.heading(`Fleet: ${appName}`);
    ui.section(
      '  Replicas',
      observations.map((o) => [
        o.server,
        o.release ?? 'no release',
      ]),
    );

    if (convergence.converged) {
      ui.success(`  All ${observations.length} replicas on ${convergence.releases[0]}`);
      continue;
    }

    for (const line of describeConvergence(appName, observations, convergence)) {
      ui.warn(`  ${line}`);
    }
  }
}

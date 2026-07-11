import { runRemoteCommandForConfig } from '../runner.js';
import { ReleaseManager } from '../../domain/release/manager.js';
import { HealthCheckService } from '../../services/health.service.js';
import { CaddyService } from '../../services/caddy.service.js';
import { ui } from '../ui.js';
import { confirm } from '../prompt.js';
import { loadConfig } from '../../config/loader.js';
import { getActiveApp } from '../../domain/workspace.js';
import { getDeploymentName, getEcosystemPath, getWebApp } from '../../domain/pm2/apps.js';
import {
  readDeployState,
  writeDeployState,
  otherColor,
  portFor,
  coloredWebName,
} from '../../domain/deploy/blue-green.js';
import type { RemoteExecutor } from '../../domain/remote/executor.js';
import type { ShipnodeConfig, ShipnodeApp } from '../../shared/types.js';
import { configForAppResult } from '../../domain/servers.js';

export async function cmdRollback(
  cwd: string,
  options: { steps?: number; app?: string; config?: string },
): Promise<void> {
  if (!options.app) {
    throw new Error(
      `rollback requires --app <name>. Available apps: ${(await loadConfig(cwd, options.config)).apps.map((a) => a.name).join(', ')}`,
    );
  }
  const fullConfig = await loadConfig(cwd, options.config);
  const selectedConfig = configForAppResult(fullConfig, options.app);
  if (selectedConfig.isErr()) {
    ui.error(selectedConfig.error.message);
    process.exit(1);
    return;
  }

  await runRemoteCommandForConfig(
    selectedConfig.value,
    async ({ config, executor }) => {
      const app = getActiveApp(config, options.app);
      const appPath = `${config.remotePath}/${app.name}`;
      const stepsBack = options.steps ?? 1;

      // Blue-green apps roll back by flipping Caddy back to the previous colour,
      // which is still running — instant and zero-drop. No pm2 restart.
      if (app.appType === 'backend' && app.zeroDowntime) {
        await rollbackBlueGreen(executor, config, app, appPath, stepsBack);
        return;
      }

      const releases = new ReleaseManager(executor, appPath, app.keepReleases);

      ui.info('Fetching release history...');
      const allReleases = await releases.listReleases();

      if (allReleases.length < 2) {
        throw new Error('No previous release to roll back to.');
      }

      const targetIdx = allReleases.length - 1 - stepsBack;
      if (targetIdx < 0) {
        throw new Error(
          `Cannot go back ${stepsBack} step(s) — only ${allReleases.length} release(s) recorded.`,
        );
      }

      const current = allReleases[allReleases.length - 1];
      const target = allReleases[targetIdx];

      ui.warn(`Current release: ${current.timestamp}`);
      ui.warn(`Target release:  ${target.timestamp}`);

      const ok = await confirm('Proceed with rollback?');
      if (!ok) {
        ui.info('Rollback cancelled.');
        return;
      }

      const targetPath = `${appPath}/releases/${target.timestamp}`;
      await releases.switchSymlink(targetPath);
      ui.success('Symlink switched');

      const namespace = getDeploymentName(config);
      if (app.appType === 'backend' && namespace) {
        const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
        const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
        // Prefer reloading from the rolled-back release's ecosystem file (ADR-0001 — it
        // restores the exact process set that was active for that release). Fall back to
        // namespace reload if the target release predates per-release ecosystem files.
        const ecosystem = getEcosystemPath(config, app.name);
        await executor.execOrThrow(
          `${mise}; mise exec node@${nodeVersion} -- ` +
          `(pm2 reload "${ecosystem}" --update-env 2>/dev/null || pm2 reload ${namespace} --update-env)`,
        );
        ui.success('PM2 reloaded');
      }

      if (app.appType === 'backend' && app.healthCheck.enabled) {
        ui.info('Running health check...');
        const health = new HealthCheckService(executor, config);
        await health.perform(app);
        ui.success('Health check passed');
      }

      ui.success(`Rolled back to ${target.timestamp}`);
    },
  );
}

/**
 * Instant blue-green rollback: the previous colour is still resident, so we
 * flip Caddy's upstream back to it and swap the persisted active colour. No
 * process restart, no dropped requests.
 *
 * Only one step back is possible — older colours were reaped by later deploys.
 * For anything deeper, redeploy the desired release instead.
 */
async function rollbackBlueGreen(
  executor: RemoteExecutor,
  config: ShipnodeConfig,
  app: ShipnodeApp,
  appPath: string,
  stepsBack: number,
): Promise<void> {
  if (stepsBack !== 1) {
    throw new Error(
      `Blue-green rollback only supports one step (the live previous colour). ` +
      `To go further back, redeploy the desired release.`,
    );
  }

  const state = await readDeployState(executor, appPath);
  if (!state) {
    throw new Error('No blue-green state found on the server — nothing to roll back to.');
  }

  const webApp = getWebApp({ ...config, apps: [app] } as ShipnodeConfig);
  if (!webApp) {
    throw new Error('No web app (pm2 app with a port) found for this deployment.');
  }
  const namespace = app.pm2?.apps[0]?.name ?? app.name;
  const previous = otherColor(state.activeColor);
  const previousPort = portFor(previous, state);
  const previousName = coloredWebName(namespace, webApp.name, previous);

  // The previous colour must still be online to serve traffic after the flip.
  // Parse pm2's JSON in-process rather than relying on `node` being on the
  // remote PATH at rollback time.
  const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
  const jlist = await executor.exec(`${mise} && mise exec -- pm2 jlist`);
  let online = false;
  try {
    const entries = JSON.parse(jlist.stdout.trim()) as Array<{ name: string; pm2_env?: { status?: string } }>;
    online = entries.some((e) => e.name === previousName && e.pm2_env?.status === 'online');
  } catch {
    online = false;
  }
  if (!online) {
    throw new Error(
      `Previous colour "${previousName}" is not running — cannot instant-rollback. ` +
      `Redeploy the desired release instead.`,
    );
  }

  ui.warn(`Active colour:   ${state.activeColor} (port ${portFor(state.activeColor, state)})`);
  ui.warn(`Rollback target: ${previous} (port ${previousPort})`);

  const ok = await confirm('Flip traffic back to the previous colour?');
  if (!ok) {
    ui.info('Rollback cancelled.');
    return;
  }

  const caddy = new CaddyService(executor, config);
  await caddy.configureBackend(app, previousPort);
  await caddy.reload();
  await writeDeployState(executor, appPath, { ...state, activeColor: previous });

  ui.success(`Rolled back — traffic now on ${previous} (port ${previousPort})`);
}

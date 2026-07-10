import { runRemoteCommandForConfig } from '../runner.js';
import { ReleaseManager } from '../../domain/release/manager.js';
import { HealthCheckService } from '../../services/health.service.js';
import { ui } from '../ui.js';
import { confirm } from '../prompt.js';
import { loadConfig } from '../../config/loader.js';
import { getActiveApp } from '../../domain/workspace.js';
import { getDeploymentName, getEcosystemPath } from '../../domain/pm2/apps.js';
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
      const releases = new ReleaseManager(executor, appPath, app.keepReleases);
      const stepsBack = options.steps ?? 1;

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

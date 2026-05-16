import { runRemoteCommand } from '../runner.js';
import { ReleaseManager } from '../../domain/release/manager.js';
import { HealthCheckService } from '../../services/health.service.js';
import { ui } from '../ui.js';
import { confirm } from '../prompt.js';

export async function cmdRollback(
  cwd: string,
  options: { steps?: number; config?: string },
): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      const releases = new ReleaseManager(executor, config.remotePath, config.keepReleases);
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

      const targetPath = `${config.remotePath}/releases/${target.timestamp}`;
      await releases.switchSymlink(targetPath);
      ui.success('Symlink switched');

      if (config.app === 'backend' && config.pm2?.name) {
        const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
        const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
        await executor.exec(
          `${mise}; mise exec node@${nodeVersion} -- pm2 reload ${config.pm2.name} --update-env`,
        );
        ui.success('PM2 reloaded');
      }

      if (config.app === 'backend' && config.healthCheck.enabled) {
        ui.info('Running health check...');
        const health = new HealthCheckService(executor, config);
        await health.perform();
        ui.success('Health check passed');
      }

      ui.success(`Rolled back to ${target.timestamp}`);
    },
    { configPath: options.config },
  );
}

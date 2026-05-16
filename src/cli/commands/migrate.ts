import { confirm } from '../prompt.js';
import { runRemoteCommand } from '../runner.js';
import { ReleaseManager } from '../../domain/release/manager.js';
import { ui } from '../ui.js';

export async function cmdMigrate(cwd: string, options: { config?: string }): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      if (!config.zeroDowntime) {
        throw new Error(
          'Migration requires zeroDowntime: true in your shipnode.config.ts. ' +
            'Enable it and re-run to migrate to the zero-downtime release structure.',
        );
      }

      const remotePath = config.remotePath;

      ui.heading('Zero-Downtime Migration');
      ui.info(`Remote path: ${remotePath}`);
      ui.warn('This will reorganise your remote deployment directory into releases/shared/current structure.');

      const ok = await confirm('Proceed with migration?');
      if (!ok) {
        ui.info('Migration cancelled.');
        return;
      }

      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('Z', '');

      ui.info('Creating release structure directories...');
      await executor.exec(
        `mkdir -p "${remotePath}/releases" "${remotePath}/shared" "${remotePath}/.shipnode"`,
      );

      await executor.exec(`echo '[]' > "${remotePath}/.shipnode/releases.json"`);
      ui.success('Directory structure created');

      ui.info(`Creating release snapshot: ${timestamp}...`);
      await executor.exec(`mkdir -p "${remotePath}/releases/${timestamp}"`);

      await executor.exec(
        `find "${remotePath}" -maxdepth 1 -mindepth 1 ` +
          `! -name releases ! -name shared ! -name .shipnode ! -name current ` +
          `-exec mv {} "${remotePath}/releases/${timestamp}/" \\;`,
      );
      ui.success('Existing files moved to release directory');

      // Move .env to shared and symlink it back
      const envCheckResult = await executor.exec(
        `[ -f "${remotePath}/releases/${timestamp}/.env" ] && echo "exists" || echo "missing"`,
      );

      if (envCheckResult.stdout.trim() === 'exists') {
        ui.info('Moving .env to shared directory...');
        await executor.exec(
          `mv "${remotePath}/releases/${timestamp}/.env" "${remotePath}/shared/.env"`,
        );
        await executor.exec(
          `ln -sf "${remotePath}/shared/.env" "${remotePath}/releases/${timestamp}/.env"`,
        );
        ui.success('Shared .env linked');
      } else {
        ui.warn('No .env found in release — skipping shared env setup.');
      }

      ui.info('Creating current symlink...');
      await executor.exec(
        `ln -sfn "${remotePath}/releases/${timestamp}" "${remotePath}/current"`,
      );
      ui.success('Symlink created: current → releases/' + timestamp);

      // Reload PM2 if applicable
      if (config.app === 'backend' && config.pm2?.name) {
        const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
        const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
        ui.info('Reloading PM2 from new path...');
        await executor.exec(
          `${mise}; mise exec node@${nodeVersion} -- pm2 reload ${config.pm2.name} --update-env`,
        );
        ui.success('PM2 reloaded');
      }

      // Record the initial migrated release
      const releases = new ReleaseManager(executor, remotePath, config.keepReleases);
      await releases.recordRelease({
        timestamp,
        status: 'success',
        duration: 0,
        gitCommit: undefined,
      });
      ui.success('Release recorded in .shipnode/releases.json');

      ui.heading('Migration Complete');
      ui.success(`Active release: ${timestamp}`);
      ui.info('Your app is now running under the zero-downtime release structure.');
      ui.info('Future deployments will use releases/ and atomic symlink switches.');
    },
    { configPath: options.config },
  );
}

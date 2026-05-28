import { readFile } from 'node:fs/promises';
import { pathExists } from 'fs-extra';
import { resolve } from 'path';
import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';
import { getDeploymentName } from '../../domain/pm2/apps.js';

export async function cmdEnv(
  cwd: string,
  options: { file?: string; config?: string },
): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      const envFile = options.file ?? config.envFile;
      const localEnvPath = resolve(cwd, envFile);

      if (!(await pathExists(localEnvPath))) {
        throw new Error(`Environment file not found: ${envFile}`);
      }

      ui.info(`Uploading ${envFile} to server...`);

      const content = await readFile(localEnvPath);
      const b64 = content.toString('base64');

      // Store with the configured envFile name so the PM2 ecosystem reference
      // (`shared/${envFile}`) and the workDir symlink target stay consistent.
      // Maintain a `.env` alias too — older configs and any external scripts
      // that read `shared/.env` keep working.
      const sharedEnv = `${config.remotePath}/shared/${config.envFile}`;
      const sharedEnvAlias = `${config.remotePath}/shared/.env`;
      await executor.exec(`mkdir -p "${config.remotePath}/shared"`);
      await executor.exec(`echo "${b64}" | base64 -d > "${sharedEnv}"`);
      await executor.exec(`chmod 600 "${sharedEnv}"`);
      if (config.envFile !== '.env') {
        await executor.exec(`ln -sf "${sharedEnv}" "${sharedEnvAlias}"`);
      }
      ui.success(`Uploaded to ${sharedEnv}`);

      const linkResult = await executor.exec(
        `if [ -d "${config.remotePath}/current" ]; then ` +
          `ln -sfn "${sharedEnv}" "${config.remotePath}/current/.env" && echo "linked"; ` +
          `fi`,
      );
      if (linkResult.stdout === 'linked') {
        ui.success('Linked shared .env to current release');
      }

      const namespace = getDeploymentName(config);
      if (config.app === 'backend' && namespace) {
        const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
        const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
        const checkResult = await executor.exec(
          `${mise}; mise exec node@${nodeVersion} -- pm2 describe ${namespace} 2>/dev/null && echo "running" || echo "stopped"`,
        );

        if (checkResult.stdout.includes('running')) {
          ui.info('Reloading deployment to pick up environment variables...');
          await executor.exec(
            `${mise}; mise exec node@${nodeVersion} -- pm2 reload ${namespace} --update-env`,
          );
          ui.success('Deployment reloaded with new environment variables');
        } else {
          ui.warn('Deployment not running. Variables will be loaded on next deploy.');
        }
      }
    },
    { configPath: options.config },
  );
}

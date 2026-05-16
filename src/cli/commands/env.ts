import { readFile, pathExists } from 'fs-extra';
import { resolve } from 'path';
import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';

export async function cmdEnv(
  cwd: string,
  options: { config?: string },
): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      const localEnvPath = resolve(cwd, config.envFile);

      if (!(await pathExists(localEnvPath))) {
        throw new Error(`Environment file not found: ${config.envFile}`);
      }

      ui.info(`Uploading ${config.envFile} to server...`);

      const content = await readFile(localEnvPath);
      const b64 = content.toString('base64');

      if (config.zeroDowntime) {
        const sharedEnv = `${config.remotePath}/shared/.env`;
        await executor.exec(`mkdir -p "${config.remotePath}/shared"`);
        await executor.exec(`echo "${b64}" | base64 -d > "${sharedEnv}"`);
        await executor.exec(`chmod 600 "${sharedEnv}"`);
        ui.success(`Uploaded to ${sharedEnv}`);

        // Link into current release if it exists
        const linkResult = await executor.exec(
          `if [ -d "${config.remotePath}/current" ]; then ` +
            `ln -sfn "${sharedEnv}" "${config.remotePath}/current/.env" && echo "linked"; ` +
            `fi`,
        );
        if (linkResult.stdout === 'linked') {
          ui.success('Linked shared .env to current release');
        }
      } else {
        const targetEnv = `${config.remotePath}/.env`;
        await executor.exec(`mkdir -p "${config.remotePath}"`);
        await executor.exec(`echo "${b64}" | base64 -d > "${targetEnv}"`);
        await executor.exec(`chmod 600 "${targetEnv}"`);
        ui.success(`Uploaded to ${targetEnv}`);
      }

      if (config.app === 'backend' && config.pm2?.name) {
        const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
        const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
        const checkResult = await executor.exec(
          `${mise}; mise exec node@${nodeVersion} -- pm2 describe ${config.pm2.name} 2>/dev/null && echo "running" || echo "stopped"`,
        );

        if (checkResult.stdout.includes('running')) {
          ui.info('Restarting app to reload environment variables...');
          await executor.exec(
            `${mise}; mise exec node@${nodeVersion} -- pm2 reload ${config.pm2.name} --update-env`,
          );
          ui.success('App restarted with new environment variables');
        } else {
          ui.warn('App not running. Variables will be loaded on next deploy.');
        }
      }
    },
    { configPath: options.config },
  );
}

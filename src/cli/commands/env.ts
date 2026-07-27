import { readFile } from 'node:fs/promises';
import { pathExists } from 'fs-extra';
import { resolve } from 'path';
import { runRemoteCommandForTargets } from '../runner.js';
import { ui } from '../ui.js';
import { getDeploymentName } from '../../domain/pm2/apps.js';
import type { RemoteExecutor } from '../../domain/remote/executor.js';

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Atomically replace a remote environment file without exposing its raw content to shell parsing. */
export async function uploadEnvironmentFile(
  executor: RemoteExecutor,
  remotePath: string,
  content: Buffer,
): Promise<void> {
  const b64 = content.toString('base64');
  await executor.execOrThrow(`mkdir -p "$(dirname ${shellSingleQuote(remotePath)})"`);
  const temporaryEnv = `${remotePath}.shipnode.XXXXXX`;
  await executor.execOrThrow([
    `tmp=$(mktemp ${shellSingleQuote(temporaryEnv)})`,
    `trap 'rm -f "$tmp"' EXIT`,
    `printf '%s' ${shellSingleQuote(b64)} | base64 -d > "$tmp"`,
    'chmod 600 "$tmp"',
    `mv -f "$tmp" ${shellSingleQuote(remotePath)}`,
    'trap - EXIT',
  ].join(' && '));
}

export async function cmdEnv(
  cwd: string,
  options: { file?: string; config?: string; app?: string; reload?: boolean; on?: string },
): Promise<void> {
  await runRemoteCommandForTargets(
    cwd,
    async ({ config, executor }) => {
      const apps = options.app
        ? config.apps.filter((app) => app.name === options.app)
        : config.apps;

      if (options.app && apps.length === 0) return;

      for (const app of apps) {
        const envFile = options.file ?? app.envFile;
        const localEnvPath = resolve(cwd, envFile);

        if (!(await pathExists(localEnvPath))) {
          throw new Error(`Environment file not found: ${envFile}`);
        }

        ui.info(`Uploading ${envFile} for app '${app.name}'...`);

        const content = await readFile(localEnvPath);
        const appPath = `${config.remotePath}/${app.name}`;
        const sharedEnv = `${appPath}/shared/${app.envFile}`;
        const sharedEnvAlias = `${appPath}/shared/.env`;
        await uploadEnvironmentFile(executor, sharedEnv, content);
        if (app.envFile !== '.env') {
          await executor.execOrThrow(`ln -sf "${sharedEnv}" "${sharedEnvAlias}"`);
        }
        ui.success(`Uploaded to ${sharedEnv}`);

        const linkResult = await executor.exec(
          `if [ -d "${appPath}/current" ]; then ` +
            `ln -sfn "${sharedEnv}" "${appPath}/current/.env" && echo "linked"; ` +
            `fi`,
        );
        if (linkResult.stdout === 'linked') {
          ui.success('Linked shared .env to current release');
        }

        if (options.reload === false) {
          ui.info(`Environment uploaded for '${app.name}' without reloading its running processes.`);
          continue;
        }

        const namespace = getDeploymentName({ ...config, apps: [app] } as any);
        if (!namespace) {
          ui.info(`No PM2 namespace configured for '${app.name}' — nothing to reload.`);
          continue;
        }

        const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
        const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
        const checkResult = await executor.exec(
          `${mise}; mise exec node@${nodeVersion} -- pm2 describe ${namespace} 2>/dev/null && echo "running" || echo "stopped"`,
        );

        if (checkResult.stdout.includes('running')) {
          ui.info(`Reloading '${app.name}' (${namespace}) to pick up environment variables...`);
          await executor.exec(
            `${mise}; mise exec node@${nodeVersion} -- pm2 reload ${namespace} --update-env`,
          );
          ui.success(`'${app.name}' reloaded with new environment variables`);
        } else {
          ui.warn(
            `'${app.name}' (${namespace}) is not running on the server. ` +
              `Run 'shipnode deploy --app ${app.name}' to start it — new env will be picked up automatically.`,
          );
        }
      }
    },
    { configPath: options.config, appName: options.app, serverName: options.on },
  );
}

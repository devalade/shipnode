import { existsSync, readFileSync } from 'fs';
import { Listr } from 'listr2';
import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';
import type { RemoteExecutor } from '../../domain/remote/executor.js';
import type { ShipnodeConfig, NetworkDatabaseConfig } from '../../shared/types.js';
import {
  buildDbInstallCommand,
  buildDbCreateCommand,
  buildDbProbeCommand,
  buildRedisInstallCommand,
  buildRedisConfigureCommand,
  buildRedisProbeCommand,
} from '../../infrastructure/provisioning/commands.js';
import { loadUsersYml, saveUsersYml, syncUsers, upsertUser } from './user.js';

const DEPLOY_USER = 'deploy';

interface SetupOptions {
  config?: string;
  noDeployUser?: boolean;
}

export async function cmdSetup(cwd: string, options: SetupOptions): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      ui.banner();
      ui.step(`Setting up ${config.ssh.user}@${config.ssh.host}`);
      const created = !options.noDeployUser && (await bootstrapDeployUser(cwd, config, executor));
      await buildTasks(executor, config, created ? DEPLOY_USER : null).run();
      if (created) {
        ui.note(
          [
            `A '${DEPLOY_USER}' user was created and owns ${config.remotePath}.`,
            `Switch ssh.user in shipnode.config.ts to '${DEPLOY_USER}', then:`,
            `  shipnode harden   # disable root SSH`,
            `  shipnode deploy`,
          ].join('\n'),
          'Next steps',
        );
      } else {
        ui.outro('Server ready — run: shipnode deploy');
      }
    },
    { configPath: options.config },
  );
}

async function bootstrapDeployUser(
  cwd: string,
  config: ShipnodeConfig,
  executor: RemoteExecutor,
): Promise<boolean> {
  const pubPath = `${config.ssh.identityFile}.pub`;
  if (!existsSync(pubPath)) {
    ui.warn(`Skipping ${DEPLOY_USER} user: no public key at ${pubPath}. Pass --no-deploy-user to silence or generate one with 'ssh-keygen'.`);
    return false;
  }
  const publicKey = readFileSync(pubPath, 'utf8').trim();
  const existing = loadUsersYml(cwd);
  const entry = { username: DEPLOY_USER, publicKey, sudo: true };
  const already = existing.find((u) => u.username === DEPLOY_USER && u.publicKey === publicKey);
  if (!already) {
    const next = upsertUser(existing, entry);
    const path = saveUsersYml(cwd, next);
    ui.info(`Registered '${DEPLOY_USER}' in ${path}`);
  }
  ui.info(`Creating '${DEPLOY_USER}' on ${config.ssh.host}...`);
  await syncUsers(executor, [entry]);
  return true;
}

function buildTasks(executor: RemoteExecutor, config: ShipnodeConfig, ownerUser: string | null) {
  const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
  const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;

  return new Listr(
    [
      {
        title: 'System dependencies',
        task: (_ctx: object, task: any) => task.newListr([
          {
            title: 'Update package index',
            task: () => executor.execOrThrow(
              'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; $SUDO apt-get update -qq',
            ),
          },
          {
            title: 'Install curl git jq rsync build-essential',
            task: () => executor.execOrThrow(
              'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ' +
              '$SUDO apt-get install -y curl git jq rsync build-essential',
            ),
          },
        ], { concurrent: false }),
      },
      {
        title: 'Mise (version manager)',
        task: () =>
          executor.execOrThrow(
            `if ! command -v mise &>/dev/null; then curl -fsSL https://mise.run | sh; fi`,
          ),
      },
      {
        title: `Node.js ${config.nodeVersion}`,
        task: (_ctx: object, task: any) => task.newListr([
          {
            title: `Install node@${nodeVersion}`,
            task: () => executor.execOrThrow(`${mise}; mise install -y "node@${nodeVersion}"`),
          },
          {
            title: `Set node@${nodeVersion} as global default`,
            task: () => executor.execOrThrow(`${mise}; mise use -g -y "node@${nodeVersion}"`),
          },
        ], { concurrent: false }),
      },
      {
        title: 'PM2',
        task: (_ctx: object, task: any) => task.newListr([
          {
            title: 'Install pm2',
            task: () => executor.execOrThrow(
              `${mise}; ` +
              `if ! mise exec "node@${nodeVersion}" -- pm2 --version &>/dev/null; then ` +
              `  mise exec "node@${nodeVersion}" -- npm install -g pm2; ` +
              `fi`,
            ),
          },
          {
            title: 'Configure systemd startup',
            task: () => executor.execOrThrow(
              `${mise}; ` +
              `mise exec "node@${nodeVersion}" -- pm2 startup systemd -u $USER --hp $HOME || true; ` +
              `mise exec "node@${nodeVersion}" -- pm2 save --force || true`,
            ),
          },
        ], { concurrent: false }),
      },
      {
        title: 'Caddy',
        task: () =>
          executor.execOrThrow(
            'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ' +
            'if ! command -v caddy &>/dev/null; then ' +
            '  $SUDO apt-get install -y debian-keyring debian-archive-keyring apt-transport-https; ' +
            '  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | $SUDO gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg; ' +
            '  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list; ' +
            '  $SUDO apt-get update && $SUDO apt-get install -y caddy; ' +
            'fi',
          ),
      },
      ...(config.database && config.database.type !== 'sqlite' && config.database.host === 'localhost'
        ? [{
            title: `Database (${config.database.type})`,
            task: (_ctx: object, task: any) => {
              const db = config.database as NetworkDatabaseConfig;
              const probe = buildDbProbeCommand(db);
              return task.newListr([
                {
                  title: `Install ${db.type}`,
                  task: () => executor.execOrThrow(buildDbInstallCommand(db)),
                },
                {
                  title: `Create user '${db.user}' and database '${db.name}'`,
                  task: () => executor.execOrThrow(buildDbCreateCommand(db)),
                },
                ...(probe ? [{ title: 'Verify connection', task: () => executor.execOrThrow(probe) }] : []),
              ], { concurrent: false });
            },
          }]
        : []),
      ...(config.redis && config.redis.host === 'localhost'
        ? [{
            title: 'Redis',
            task: (_ctx: object, task: any) => {
              const redis = config.redis!;
              const probe = buildRedisProbeCommand(redis);
              return task.newListr([
                {
                  title: 'Install redis-server',
                  task: () => executor.execOrThrow(buildRedisInstallCommand(redis)),
                },
                ...(redis.password ? [{
                  title: 'Set password',
                  task: () => executor.execOrThrow(buildRedisConfigureCommand(redis)),
                }] : []),
                ...(probe ? [{ title: 'Verify connection', task: () => executor.execOrThrow(probe) }] : []),
              ], { concurrent: false });
            },
          }]
        : []),
      {
        title: 'Deployment directories',
        task: (_ctx: object, task: any) => task.newListr([
          {
            title: `Create release structure at ${config.remotePath}`,
            task: () => executor.execOrThrow(
              'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ' +
              `$SUDO mkdir -p "${config.remotePath}" && ` +
              (ownerUser ? `$SUDO chown "${ownerUser}:${ownerUser}" "${config.remotePath}" && ` : '') +
              `$SUDO -u "${ownerUser ?? '$USER'}" mkdir -p "${config.remotePath}/releases" "${config.remotePath}/shared" "${config.remotePath}/.shipnode"`,
            ),
          },
          {
            title: 'Configure Caddy include',
            task: () => executor.execOrThrow(
              'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ' +
              '$SUDO mkdir -p /etc/caddy/conf.d /var/log/caddy && ' +
              'grep -q "import /etc/caddy/conf.d" /etc/caddy/Caddyfile 2>/dev/null || ' +
              'echo "import /etc/caddy/conf.d/*.caddy" | $SUDO tee -a /etc/caddy/Caddyfile > /dev/null && ' +
              '$SUDO systemctl reload caddy 2>/dev/null || true',
            ),
          },
        ], { concurrent: false }),
      },
    ],
    { rendererOptions: { collapseErrors: false } },
  );
}

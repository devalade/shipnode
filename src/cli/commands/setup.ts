import { existsSync, readFileSync } from 'fs';
import { Result, type Result as ResultType } from 'better-result';
import { Listr } from 'listr2';
import { runRemoteCommandForTargets } from '../runner.js';
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
import { isFleet } from '../../domain/servers.js';
import { loadUsersYml, saveUsersYml, syncUsers, upsertUser } from './user.js';
import { Pm2StartupError } from '../../shared/result-errors.js';

const DEPLOY_USER = 'deploy';

interface SetupOptions {
  config?: string;
  noDeployUser?: boolean;
  on?: string;
}

export async function cmdSetup(cwd: string, options: SetupOptions): Promise<void> {
  await runRemoteCommandForTargets(
    cwd,
    async ({ config, executor, serverName }) => {
      ui.banner();
      ui.step(`Setting up ${serverName} (${config.ssh.user}@${config.ssh.host})`);
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
    { configPath: options.config, includeEmpty: true, serverName: options.on },
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
  // Grant NOPASSWD sudo — shipnode's non-interactive setup/harden/deploy all
  // assume sudo doesn't prompt. Industry-standard for CI/deploy accounts; the
  // tradeoff is that a compromise of the deploy user's SSH key gets root.
  await executor.execOrThrow(
    `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
    `echo "${DEPLOY_USER} ALL=(ALL) NOPASSWD:ALL" | $SUDO tee "/etc/sudoers.d/shipnode-${DEPLOY_USER}" > /dev/null && ` +
    `$SUDO chmod 440 "/etc/sudoers.d/shipnode-${DEPLOY_USER}"`,
  );
  return true;
}

/**
 * Wrap a command so it runs as `user` when set, otherwise as the current SSH user.
 * `bash -lc` gives the target user a login shell so $HOME/$PATH resolve to theirs.
 * Uses `sudo -u` unconditionally — sudo is transparent (no password) when the SSH
 * user is already root, and the conditional `$SUDO` fallback breaks on `sudo -u`
 * because it leaves `-u` as the leading token when SUDO="".
 */
/**
 * Run a command as another user, from a directory that user can actually read.
 *
 * `sudo` inherits the caller's working directory, and setup normally runs over
 * SSH as root, whose home is mode 700. Node's `spawn()` returns EACCES when the
 * working directory is unreadable, so every pm2 command that starts the daemon
 * failed — reporting `spawn /home/deploy/.../node EACCES`, which names the node
 * binary and hides the real cause. `-H` sets HOME to the target user's rather
 * than leaving root's.
 */
function asUser(user: string | null, cmd: string): string {
  if (!user) return cmd;
  const escaped = `cd "$HOME" 2>/dev/null || cd /; ${cmd}`.replace(/'/g, "'\\''");
  return `sudo -u "${user}" -H bash -lc '${escaped}'`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Whether this server needs Caddy.
 *
 * A domain is the obvious case. A fleet replica is the non-obvious one: it
 * deliberately has *no* domain — five replicas claiming one name would race
 * Let's Encrypt — but it still needs Caddy to serve the app for the load
 * balancer, which health-checks the replica directly. Gating on `domain` alone
 * left fleet replicas without Caddy, and the first deploy died writing its site
 * file into a directory that was never created.
 */
function needsCaddy(config: ShipnodeConfig): boolean {
  return config.apps.some((app) => app.domain !== undefined || isFleet(config, app));
}

export function buildTasks(executor: RemoteExecutor, config: ShipnodeConfig, ownerUser: string | null) {
  const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
  const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
  // When a deploy user was bootstrapped, install mise/node/pm2 into their home
  // so PM2 processes run as that user and `pm2-<user>.service` matches. Without
  // this, everything lands in root's home and deploy has no pm2 on their PATH.
  const effectiveUser = ownerUser ?? config.ssh.user;
  const hasApps = config.apps.length > 0;
  const hasAccessories = Object.keys(config.accessories ?? {}).length > 0;

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
      ...(hasApps ? [{
        title: `Mise (version manager)${ownerUser ? ` for ${ownerUser}` : ''}`,
        task: () =>
          executor.execOrThrow(
            asUser(
              ownerUser,
              `if ! command -v mise &>/dev/null && [ ! -x "$HOME/.local/bin/mise" ]; then curl -fsSL https://mise.run | sh; fi`,
            ),
          ),
      }] : []),
      ...(hasApps ? [{
        title: `Node.js ${config.nodeVersion}`,
        task: (_ctx: object, task: any) => task.newListr([
          {
            title: `Install node@${nodeVersion}`,
            task: () => executor.execOrThrow(asUser(ownerUser, `${mise}; mise install -y "node@${nodeVersion}"`)),
          },
          {
            title: `Set node@${nodeVersion} as global default`,
            task: () => executor.execOrThrow(asUser(ownerUser, `${mise}; mise use -g -y "node@${nodeVersion}"`)),
          },
        ], { concurrent: false }),
      }] : []),
      ...(hasApps && config.apps.some((app) => app.appType === 'backend' && app.pm2) ? [{
        title: 'PM2',
        task: (_ctx: object, task: any) => task.newListr([
          {
            title: 'Install pm2',
            task: () => executor.execOrThrow(
              asUser(
                ownerUser,
                `${mise}; ` +
                `if ! mise exec "node@${nodeVersion}" -- pm2 --version &>/dev/null; then ` +
                `  mise exec "node@${nodeVersion}" -- npm install -g pm2; ` +
                `fi`,
              ),
            ),
          },
          {
            // pm2 startup writes /etc/systemd/system/pm2-<user>.service — needs root
            // to write the unit + enable it, but the unit targets the deploy user.
            // pm2 save writes ~/.pm2/dump.pm2 for that user and must run as them.
            //
            // npm-installed globals like pm2 don't get valid mise shims (mise only
            // shims tools it manages itself), so we resolve pm2's real path via
            // `mise exec node@X -- which pm2` and pass that to `env PATH=... pm2`.
            title: `Configure systemd startup (${ownerUser ?? '$USER'})`,
            task: async () => {
              const result = await configurePm2Startup(
                executor,
                effectiveUser,
                ownerUser,
                nodeVersion,
                mise,
              );
              if (result.isErr()) throw result.error;
            },
          },
        ], { concurrent: false }),
      }] : []),
      ...(hasApps && needsCaddy(config) ? [{
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
      }] : []),
      ...(hasAccessories ? [{
        title: 'Docker',
        task: () =>
          executor.execOrThrow(
            'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ' +
            'if ! command -v docker &>/dev/null; then ' +
            '  $SUDO apt-get install -y ca-certificates curl gnupg; ' +
            '  $SUDO install -m 0755 -d /etc/apt/keyrings; ' +
            '  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg; ' +
            '  $SUDO chmod a+r /etc/apt/keyrings/docker.gpg; ' +
            '  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | $SUDO tee /etc/apt/sources.list.d/docker.list > /dev/null; ' +
            '  $SUDO apt-get update && $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; ' +
            'fi; ' +
            '$SUDO systemctl enable docker && $SUDO systemctl start docker',
          ),
      }] : []),
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
      ...(hasApps ? [{
        title: 'Deployment directories',
        task: (_ctx: object, task: any) => task.newListr([
          {
            title: `Create release structure at ${config.remotePath}`,
            task: () => executor.execOrThrow(
              'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ' +
              `OWNER=${shellQuote(effectiveUser)}; GROUP=$(id -gn "$OWNER"); ` +
              `$SUDO install -d -m 0755 -o "$OWNER" -g "$GROUP" ` +
              `${shellQuote(config.remotePath)} ${shellQuote(`${config.remotePath}/releases`)} ` +
              `${shellQuote(`${config.remotePath}/shared`)} ${shellQuote(`${config.remotePath}/.shipnode`)}`,
            ),
          },
          ...(needsCaddy(config) ? [{
            title: 'Configure Caddy include',
            task: () => executor.execOrThrow(
              'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ' +
              '$SUDO mkdir -p /etc/caddy/conf.d /var/log/caddy && ' +
              'grep -q "import /etc/caddy/conf.d" /etc/caddy/Caddyfile 2>/dev/null || ' +
              'echo "import /etc/caddy/conf.d/*.caddy" | $SUDO tee -a /etc/caddy/Caddyfile > /dev/null && ' +
              '$SUDO systemctl reload caddy 2>/dev/null || true',
            ),
          }] : []),
        ], { concurrent: false }),
      }] : []),
    ],
    { rendererOptions: { collapseErrors: false } },
  );
}

async function configurePm2Startup(
  executor: RemoteExecutor,
  effectiveUser: string,
  runAsUser: string | null,
  nodeVersion: string,
  mise: string,
): Promise<ResultType<void, Pm2StartupError>> {
  const resolvePm2 = asUser(runAsUser, `${mise}; mise exec "node@${nodeVersion}" -- which pm2`);
  const savePm2 = asUser(
    runAsUser,
    `${mise}; mise exec "node@${nodeVersion}" -- pm2 save --force`,
  );
  const unit = `pm2-${effectiveUser}.service`;
  const command =
    'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ' +
    `OWNER=${shellQuote(effectiveUser)}; HOME_DIR=$(getent passwd "$OWNER" | cut -d: -f6); ` +
    `PM2_BIN=$(${resolvePm2}); ` +
    `[ -n "$HOME_DIR" ] && [ -x "$PM2_BIN" ] && ` +
    `$SUDO env PATH="$(dirname "$PM2_BIN"):$PATH" "$PM2_BIN" startup systemd -u "$OWNER" --hp "$HOME_DIR" && ` +
    `$SUDO test -f ${shellQuote(`/etc/systemd/system/${unit}`)} && ` +
    `$SUDO systemctl is-enabled --quiet ${shellQuote(unit)} && ` +
    savePm2;

  const result = await executor.exec(command);
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim() || `command exited with ${result.exitCode}`;
    return Result.err(new Pm2StartupError({ user: effectiveUser, detail }));
  }
  return Result.ok(undefined);
}

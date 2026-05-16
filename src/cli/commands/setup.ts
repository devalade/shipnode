import { Listr } from 'listr2';
import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';
import type { RemoteExecutor } from '../../domain/remote/executor.js';
import type { ShipnodeConfig } from '../../shared/types.js';

export async function cmdSetup(cwd: string, options: { config?: string }): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      ui.banner();
      ui.step(`Setting up ${config.ssh.user}@${config.ssh.host}`);

      await buildTasks(executor, config).run();

      ui.outro('Server ready — run: shipnode deploy');
    },
    { configPath: options.config },
  );
}

function buildTasks(executor: RemoteExecutor, config: ShipnodeConfig) {
  const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
  const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;

  return new Listr(
    [
      {
        title: 'System dependencies',
        task: () =>
          executor.exec(
            'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ' +
            '$SUDO apt-get update -qq && ' +
            '$SUDO apt-get install -y curl git jq rsync build-essential',
          ),
      },
      {
        title: 'Mise (version manager)',
        task: () =>
          executor.exec(
            `if ! command -v mise &>/dev/null; then curl -fsSL https://mise.run | sh; fi`,
          ),
      },
      {
        title: `Node.js ${nodeVersion}`,
        task: () =>
          executor.exec(
            `${mise}; ` +
            `mise install -y "node@${nodeVersion}"; ` +
            `mise use -g -y "node@${nodeVersion}"`,
          ),
      },
      {
        title: 'PM2',
        task: () =>
          executor.exec(
            `${mise}; ` +
            `if ! mise exec "node@${nodeVersion}" -- pm2 --version &>/dev/null; then ` +
            `  mise exec "node@${nodeVersion}" -- npm install -g pm2; ` +
            `fi; ` +
            `mise exec "node@${nodeVersion}" -- pm2 startup systemd -u $USER --hp $HOME || true; ` +
            `mise exec "node@${nodeVersion}" -- pm2 save --force || true`,
          ),
      },
      {
        title: 'Caddy',
        task: () =>
          executor.exec(
            'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ' +
            'if ! command -v caddy &>/dev/null; then ' +
            '  $SUDO apt-get install -y debian-keyring debian-archive-keyring apt-transport-https; ' +
            '  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | $SUDO gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg; ' +
            '  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list; ' +
            '  $SUDO apt-get update && $SUDO apt-get install -y caddy; ' +
            'fi',
          ),
      },
      {
        title: 'Deployment directories',
        task: async () => {
          await executor.exec(
            `mkdir -p "${config.remotePath}/releases" "${config.remotePath}/shared" "${config.remotePath}/.shipnode"`,
          );
          await executor.exec(
            'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ' +
            '$SUDO mkdir -p /etc/caddy/conf.d /var/log/caddy && ' +
            'grep -q "import /etc/caddy/conf.d" /etc/caddy/Caddyfile 2>/dev/null || ' +
            'echo "import /etc/caddy/conf.d/*.caddy" | $SUDO tee -a /etc/caddy/Caddyfile > /dev/null && ' +
            '$SUDO systemctl reload caddy 2>/dev/null || true',
          );
        },
      },
    ],
    { rendererOptions: { collapseErrors: false } },
  );
}

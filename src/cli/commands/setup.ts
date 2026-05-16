import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';

export async function cmdSetup(cwd: string, options: { config?: string }): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
      const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;

      ui.info(`Setting up server ${config.ssh.user}@${config.ssh.host}...`);

      ui.info('Installing system dependencies...');
      await executor.exec(
        'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ' +
        '$SUDO apt-get update -qq && ' +
        '$SUDO apt-get install -y curl git jq rsync build-essential',
      );
      ui.success('System dependencies installed');

      ui.info('Installing Mise (version manager)...');
      await executor.exec(
        `if ! command -v mise &>/dev/null; then curl -fsSL https://mise.run | sh; fi`,
      );
      ui.success('Mise ready');

      ui.info(`Installing Node.js ${nodeVersion}...`);
      await executor.exec(
        `${mise}; ` +
        `mise install -y "node@${nodeVersion}"; ` +
        `mise use -g -y "node@${nodeVersion}"`,
      );
      ui.success(`Node.js ${nodeVersion} installed`);

      ui.info('Installing PM2...');
      await executor.exec(
        `${mise}; ` +
        `if ! mise exec "node@${nodeVersion}" -- pm2 --version &>/dev/null; then ` +
        `  mise exec "node@${nodeVersion}" -- npm install -g pm2; ` +
        `fi; ` +
        `mise exec "node@${nodeVersion}" -- pm2 startup systemd -u $USER --hp $HOME || true; ` +
        `mise exec "node@${nodeVersion}" -- pm2 save --force || true`,
      );
      ui.success('PM2 ready');

      ui.info('Installing Caddy...');
      await executor.exec(
        'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ' +
        'if ! command -v caddy &>/dev/null; then ' +
        '  $SUDO apt-get install -y debian-keyring debian-archive-keyring apt-transport-https; ' +
        '  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | $SUDO gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg; ' +
        '  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list; ' +
        '  $SUDO apt-get update && $SUDO apt-get install -y caddy; ' +
        'fi',
      );
      ui.success('Caddy ready');

      ui.info('Creating deployment directories...');
      await executor.exec(
        `mkdir -p "${config.remotePath}/releases" "${config.remotePath}/shared" "${config.remotePath}/.shipnode"`,
      );

      await executor.exec(
        'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ' +
        '$SUDO mkdir -p /etc/caddy/conf.d /var/log/caddy',
      );
      ui.success('Directories created');

      ui.success(`Server ready — run: shipnode deploy`);
    },
    { configPath: options.config },
  );
}

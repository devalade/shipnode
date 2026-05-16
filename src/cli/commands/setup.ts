import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';

export async function cmdSetup(cwd: string, options: { config?: string }): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      ui.info(`Setting up server ${config.ssh.host}...`);

      ui.info('Installing system dependencies...');
      await executor.exec('sudo apt update && sudo apt install -y curl git jq rsync build-essential');
      ui.success('System dependencies installed');

      ui.info('Installing Mise (version manager)...');
      await executor.exec('curl -fsSL https://mise.run | sh');
      await executor.exec('export PATH="$HOME/.local/bin:$PATH" && mise settings experimental=1');
      ui.success('Mise installed');

      ui.info('Installing PM2...');
      await executor.exec(
        `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH" && ` +
        `mise use -y "node@${config.nodeVersion}" && ` +
        `mise install -y && ` +
        `npm install -g pm2`,
      );
      ui.success('PM2 installed');

      ui.info('Installing Caddy...');
      await executor.exec(
        'sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl && ' +
        'curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && ' +
        'curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" | sudo tee /etc/apt/sources.list.d/caddy-stable.list && ' +
        'sudo apt update && sudo apt install -y caddy',
      );
      ui.success('Caddy installed');

      ui.info('Creating deployment directories...');
      await executor.exec(`mkdir -p "${config.remotePath}/releases"`);
      await executor.exec(`mkdir -p "${config.remotePath}/shared"`);
      await executor.exec(`mkdir -p "${config.remotePath}/.shipnode"`);
      ui.success('Directories created');

      ui.info('Configuring Caddy directory...');
      await executor.exec('sudo mkdir -p /etc/caddy/conf.d');
      await executor.exec('sudo mkdir -p /var/log/caddy');
      ui.success('Caddy directories created');

      ui.success('Server setup complete');
    },
    { configPath: options.config },
  );
}

import { loadConfig } from '../../config/loader.js';
import { SshConnection } from '../../infrastructure/ssh/connection.js';
import { getActiveApp } from '../../domain/workspace.js';
import { runMonitor } from '../monitor/index.js';
import { ui } from '../ui.js';

export async function cmdMonitor(
  cwd: string,
  options: { interval?: string; app?: string; config?: string },
): Promise<void> {
  const interval = Math.max(1, parseInt(options.interval ?? '2', 10) || 2);
  const config = await loadConfig(cwd, options.config);
  const app = options.app ? getActiveApp(config, options.app) : config.apps[0];

  if (!app) {
    ui.error('No app configured in shipnode.config.ts');
    process.exit(1);
  }

  const host = `${config.ssh.user}@${config.ssh.host}:${config.ssh.port}`;
  const ssh = new SshConnection();

  try {
    await ssh.connect(config.ssh);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ui.error(`Failed to connect to ${host}: ${msg}`);
    process.exit(1);
  }

  try {
    await runMonitor({
      executor: ssh,
      config,
      app,
      interval,
    });
  } finally {
    ssh.disconnect();
  }
}

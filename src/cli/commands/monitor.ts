import { loadConfig } from '../../config/loader.js';
import { SshConnection } from '../../infrastructure/ssh/connection.js';
import { runMonitor } from '../monitor/index.js';
import { getAccessoriesForMonitorTarget, getAppsForMonitorTarget, resolveMonitorSession } from '../monitor/monitor-session.js';
import { ui } from '../ui.js';

export async function cmdMonitor(
  cwd: string,
  options: { interval?: string; app?: string; config?: string },
): Promise<void> {
  const interval = Math.max(1, parseInt(options.interval ?? '2', 10) || 2);
  const config = await loadConfig(cwd, options.config);
  const session = resolveMonitorSession(config, options.app);
  if (session.isErr()) {
    ui.error(session.error.message);
    process.exit(1);
    return;
  }

  const apps = getAppsForMonitorTarget(config, session.value.target.name);
  if (apps.isErr()) {
    ui.error(apps.error.message);
    process.exit(1);
    return;
  }

  const accessoryNames = getAccessoriesForMonitorTarget(config, session.value.target.name);
  if (accessoryNames.isErr()) {
    ui.error(accessoryNames.error.message);
    process.exit(1);
    return;
  }

  const host = `${session.value.target.ssh.user}@${session.value.target.ssh.host}:${session.value.target.ssh.port}`;
  const ssh = new SshConnection();

  try {
    await ssh.connect(session.value.target.ssh);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ui.error(`Failed to connect to ${host}: ${msg}`);
    process.exit(1);
    return;
  }

  try {
    await runMonitor({
      executor: ssh,
      config,
      app: session.value.app,
      apps: apps.value,
      accessoryNames: accessoryNames.value,
      targetName: session.value.target.name,
      host,
      interval,
    });
  } finally {
    ssh.disconnect();
  }
}

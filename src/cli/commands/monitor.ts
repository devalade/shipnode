import { loadConfig } from '../../config/loader.js';
import { SshConnection } from '../../infrastructure/ssh/connection.js';
import { configForServer } from '../../domain/servers.js';
import type { ShipnodeConfig } from '../../shared/types.js';
import { runMonitor } from '../monitor/index.js';
import {
  getAccessoriesForMonitorTarget,
  getAppsForMonitorTarget,
  resolveMonitorSession,
} from '../monitor/monitor-session.js';
import { observeStateJson, printObserveStatus, takeSnapshot } from '../observe.js';
import { ui } from '../ui.js';

export async function cmdMonitor(
  cwd: string,
  options: { interval?: string; app?: string; config?: string; on?: string; once?: boolean; json?: boolean },
): Promise<void> {
  const interval = Math.max(1, parseInt(options.interval ?? '2', 10) || 2);
  const config = await loadConfig(cwd, options.config);

  if (options.once === true || options.json === true) {
    await printSnapshot(config, options, interval);
    return;
  }

  await runLiveDashboard(config, { app: options.app, on: options.on, interval });
}

async function printSnapshot(
  config: ShipnodeConfig,
  options: { app?: string; on?: string; json?: boolean },
  intervalSeconds: number,
): Promise<void> {
  const snapshot = await takeSnapshot(config, {
    app: options.app,
    on: options.on,
    intervalSeconds,
  });
  if (snapshot.isErr()) {
    ui.error(snapshot.error.message);
    process.exit(1);
    return;
  }
  if (options.json) process.stdout.write(observeStateJson(snapshot.value));
  else printObserveStatus(snapshot.value, { narrowed: options.on !== undefined });
}

async function runLiveDashboard(
  config: ShipnodeConfig,
  options: { app?: string; on?: string; interval: number },
): Promise<void> {
  const session = resolveMonitorSession(config, options.app, options.on);
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

  const { target, app } = session.value;
  const host = `${target.ssh.user}@${target.ssh.host}:${target.ssh.port}`;
  const ssh = new SshConnection();
  try {
    await ssh.connect(target.ssh);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ui.error(`Failed to connect to ${host}: ${msg}`);
    process.exit(1);
    return;
  }

  try {
    await runMonitor({
      executor: ssh,
      config: configForServer(config, target.name),
      app,
      apps: apps.value,
      accessoryNames: accessoryNames.value,
      targetName: target.name,
      host,
      interval: options.interval,
    });
  } finally {
    ssh.disconnect();
  }
}

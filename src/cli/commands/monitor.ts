import { loadConfig } from '../../config/loader.js';
import type { ShipnodeConfig } from '../../shared/types.js';
import { runMonitor } from '../monitor/index.js';
import { connectFleet, observeStateJson, planObserveHosts, printObserveStatus, takeSnapshot } from '../observe.js';
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
  // The whole workspace by default; --app and --on narrow it. A fleet is
  // exactly what this view is for, so nothing here insists on a single replica.
  const plan = planObserveHosts(config, { app: options.app, on: options.on });
  if (plan.isErr()) {
    ui.error(plan.error.message);
    process.exit(1);
    return;
  }
  if (plan.value.length === 0) {
    ui.error('Nothing to monitor: no server runs an app or accessory.');
    process.exit(1);
    return;
  }

  const fleet = await connectFleet(config, plan.value);
  try {
    await runMonitor({ fleet, interval: options.interval, focusApp: options.app });
  } finally {
    fleet.close();
  }
}

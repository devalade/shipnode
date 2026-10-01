import { loadConfig } from '../../config/loader.js';
import { printObserveStatus, takeSnapshot } from '../observe.js';
import { ui } from '../ui.js';

export async function cmdStatus(cwd: string, options: { config?: string; app?: string; on?: string }): Promise<void> {
  const config = await loadConfig(cwd, options.config);
  const snapshot = await takeSnapshot(config, { app: options.app, on: options.on });
  if (snapshot.isErr()) {
    ui.error(snapshot.error.message);
    process.exit(1);
    return;
  }
  printObserveStatus(snapshot.value, { narrowed: options.on !== undefined });
}

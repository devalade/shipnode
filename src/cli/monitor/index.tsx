import { render } from 'ink';
import type { RemoteExecutor } from '../../domain/remote/executor.js';
import type { ShipnodeConfig, ShipnodeApp } from '../../shared/types.js';
import { App } from './App.js';

interface MonitorOptions {
  executor: RemoteExecutor;
  config: ShipnodeConfig;
  app: ShipnodeApp;
  apps: ShipnodeApp[];
  accessoryNames: string[];
  targetName: string;
  host: string;
  interval: number;
}

export async function runMonitor(options: MonitorOptions): Promise<void> {
  const { waitUntilExit } = render(<App {...options} />);
  await waitUntilExit();
}

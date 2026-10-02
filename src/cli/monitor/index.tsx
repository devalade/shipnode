import { render } from 'ink';
import type { FleetConnection } from '../observe.js';
import { App } from './App.js';

interface MonitorOptions {
  fleet: FleetConnection;
  interval: number;
  /** Start with this app selected in the overview. */
  focusApp?: string;
}

export async function runMonitor(options: MonitorOptions): Promise<void> {
  const { waitUntilExit } = render(<App {...options} />);
  await waitUntilExit();
}

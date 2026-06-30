import type { ShipnodeConfig, ShipnodeApp } from '../shared/types.js';

export function getActiveApp(config: ShipnodeConfig, name?: string): ShipnodeApp {
  if (name) {
    const found = config.apps.find((a) => a.name === name);
    if (!found) throw new Error(`No app named "${name}" in this workspace`);
    return found;
  }
  return config.apps[0];
}

import type { AccessoryConfig, ShipnodeApp, ShipnodeConfig, SshConfig } from '../shared/types.js';

export const DEFAULT_SERVER_TARGET = 'default';

export interface ServerTarget {
  name: string;
  ssh: SshConfig;
}

export function resolveServerName(config: ShipnodeConfig, target?: string): string {
  if (target) return target;
  if (config.servers[DEFAULT_SERVER_TARGET]) return DEFAULT_SERVER_TARGET;
  const names = Object.keys(config.servers);
  if (names.length === 1) return names[0]!;
  throw new Error(`Server target is required when no '${DEFAULT_SERVER_TARGET}' server is configured`);
}

export function getServerTarget(config: ShipnodeConfig, target?: string): ServerTarget {
  const name = resolveServerName(config, target);
  const ssh = config.servers[name];
  if (!ssh) {
    const known = Object.keys(config.servers).join(', ') || '(none)';
    throw new Error(`Unknown server target '${name}'. Known targets: ${known}`);
  }
  return { name, ssh };
}

export function getServerTargets(config: ShipnodeConfig): ServerTarget[] {
  return Object.entries(config.servers).map(([name, ssh]) => ({ name, ssh }));
}

export function getAppsForServer(config: ShipnodeConfig, serverName: string): ShipnodeApp[] {
  return config.apps.filter((app) => resolveServerName(config, app.on) === serverName);
}

export function getAccessoriesForServer(config: ShipnodeConfig, serverName: string): Record<string, AccessoryConfig> {
  const entries = Object.entries(config.accessories ?? {})
    .filter(([, accessory]) => resolveServerName(config, accessory.on) === serverName);
  return Object.fromEntries(entries);
}

export function configForServer(config: ShipnodeConfig, serverName: string): ShipnodeConfig {
  const ssh = getServerTarget(config, serverName).ssh;
  return {
    ...config,
    ssh,
    apps: getAppsForServer(config, serverName),
    accessories: getAccessoriesForServer(config, serverName),
  };
}

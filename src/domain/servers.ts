import { Result, type Result as ResultType } from 'better-result';
import type { AccessoryConfig, ShipnodeApp, ShipnodeConfig, SshConfig } from '../shared/types.js';
import {
  MissingServerTargetError,
  UnknownAppError,
  UnknownServerTargetError,
  type AppTargetError,
  type ServerTargetError,
} from '../shared/result-errors.js';

export const DEFAULT_SERVER_TARGET = 'default';

export interface ServerTarget {
  name: string;
  ssh: SshConfig;
}

export function resolveServerName(config: ShipnodeConfig, target?: string): string {
  return resolveServerNameResult(config, target).unwrap();
}

export function resolveServerNameResult(
  config: ShipnodeConfig,
  target?: string,
): ResultType<string, ServerTargetError> {
  if (target) return Result.ok(target);
  if (config.servers[DEFAULT_SERVER_TARGET]) return Result.ok(DEFAULT_SERVER_TARGET);
  const names = Object.keys(config.servers);
  if (names.length === 1) return Result.ok(names[0]!);
  return Result.err(new MissingServerTargetError());
}

export function getServerTarget(config: ShipnodeConfig, target?: string): ServerTarget {
  return getServerTargetResult(config, target).unwrap();
}

export function getServerTargetResult(
  config: ShipnodeConfig,
  target?: string,
): ResultType<ServerTarget, ServerTargetError> {
  const resolved = resolveServerNameResult(config, target);
  if (resolved.isErr()) return Result.err(resolved.error);
  const name = resolved.value;
  const ssh = config.servers[name];
  if (!ssh) {
    const known = Object.keys(config.servers).join(', ') || '(none)';
    return Result.err(new UnknownServerTargetError({ target: name, known }));
  }
  return Result.ok({ name, ssh });
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

export function configForApp(config: ShipnodeConfig, appName: string): ShipnodeConfig {
  return configForAppResult(config, appName).unwrap();
}

export function configForAppResult(
  config: ShipnodeConfig,
  appName: string,
): ResultType<ShipnodeConfig, AppTargetError> {
  const app = config.apps.find((candidate) => candidate.name === appName);
  if (!app) {
    return Result.err(new UnknownAppError({ name: appName }));
  }
  const server = getServerTargetResult(config, app.on);
  if (server.isErr()) return Result.err(server.error);
  return Result.ok({ ...configForServer(config, server.value.name), apps: [app] });
}

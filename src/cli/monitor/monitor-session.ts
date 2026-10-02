import { Result, type Result as ResultType } from 'better-result';
import { resolveServerNamesResult } from '../../domain/servers.js';
import type { ShipnodeApp, ShipnodeConfig } from '../../shared/types.js';
import type { ServerTargetError } from '../../shared/result-errors.js';

export function getAppsForMonitorTarget(
  config: ShipnodeConfig,
  targetName: string,
): ResultType<ShipnodeApp[], ServerTargetError> {
  const apps: ShipnodeApp[] = [];
  for (const app of config.apps) {
    const serverNames = resolveServerNamesResult(config, app.on);
    if (serverNames.isErr()) return Result.err(serverNames.error);
    if (serverNames.value.includes(targetName)) apps.push(app);
  }
  return Result.ok(apps);
}

export function getAccessoriesForMonitorTarget(
  config: ShipnodeConfig,
  targetName: string,
): ResultType<string[], ServerTargetError> {
  const names: string[] = [];
  for (const [name, accessory] of Object.entries(config.accessories ?? {})) {
    const serverNames = resolveServerNamesResult(config, accessory.on);
    if (serverNames.isErr()) return Result.err(serverNames.error);
    if (serverNames.value.includes(targetName)) names.push(name);
  }
  return Result.ok(names);
}

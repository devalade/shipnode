import { Result, type Result as ResultType } from 'better-result';
import { getServerTargetResult, resolveServerNamesResult, type ServerTarget } from '../../domain/servers.js';
import type { ShipnodeApp, ShipnodeConfig } from '../../shared/types.js';
import { UnknownAppError, type AppTargetError, type ServerTargetError } from '../../shared/result-errors.js';

export interface MonitorSession {
  config: ShipnodeConfig;
  app: ShipnodeApp;
  target: ServerTarget;
}

export function resolveMonitorSession(
  config: ShipnodeConfig,
  appName?: string,
): ResultType<MonitorSession, AppTargetError> {
  const app = appName === undefined
    ? config.apps[0]
    : config.apps.find((candidate) => candidate.name === appName);

  if (app === undefined) return Result.err(new UnknownAppError({ name: appName ?? '(default)' }));

  // The monitor holds one live connection, so a fleet app must be narrowed to
  // one replica first (`monitor --on <server>`).
  const target = getServerTargetResult(config, app.on, `App '${app.name}'`);
  if (target.isErr()) return Result.err(target.error);

  return Result.ok({ config, app, target: target.value });
}

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

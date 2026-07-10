import { Result, type Result as ResultType } from 'better-result';
import { getServerTargetResult, resolveServerNameResult, type ServerTarget } from '../../domain/servers.js';
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

  const target = getServerTargetResult(config, app.on);
  if (target.isErr()) return Result.err(target.error);

  return Result.ok({ config, app, target: target.value });
}

export function getAppsForMonitorTarget(
  config: ShipnodeConfig,
  targetName: string,
): ResultType<ShipnodeApp[], ServerTargetError> {
  const apps: ShipnodeApp[] = [];
  for (const app of config.apps) {
    const serverName = resolveServerNameResult(config, app.on);
    if (serverName.isErr()) return Result.err(serverName.error);
    if (serverName.value === targetName) apps.push(app);
  }
  return Result.ok(apps);
}

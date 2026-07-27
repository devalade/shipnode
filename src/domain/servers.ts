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

/**
 * Which servers must be visited before which, derived from `dependsOn`.
 *
 * Maps a server to the set of *other* servers it needs first. An app declaring
 * `dependsOn: ['postgres']` where postgres lives elsewhere means that
 * accessory's host has to be up before this one is deployed and health-checked.
 * Same-server dependencies impose no ordering — the orchestrator already
 * starts a server's own accessories before its apps.
 */
function serverPrerequisites(config: ShipnodeConfig): Map<string, Set<string>> {
  const needs = new Map<string, Set<string>>();

  for (const app of config.apps) {
    const appServer = resolveServerName(config, app.on);
    for (const name of app.dependsOn ?? []) {
      const accessory = config.accessories?.[name];
      if (!accessory) continue;
      const accessoryServer = resolveServerName(config, accessory.on);
      if (accessoryServer === appServer) continue;

      const existing = needs.get(appServer) ?? new Set<string>();
      existing.add(accessoryServer);
      needs.set(appServer, existing);
    }
  }

  return needs;
}

/**
 * Every server, ordered so that a server hosting an accessory comes before the
 * servers whose apps depend on it.
 *
 * Declaration order is the tiebreak, so a workspace without cross-server
 * `dependsOn` is traversed exactly as written. Without this, ordering is purely
 * the order of the `servers` literal: declare the app server first and its
 * health check runs before the database it needs has been started.
 *
 * A dependency cycle is not an error — two servers can legitimately host
 * accessories the other's apps consume. Cycle members fall back to declaration
 * order rather than throwing.
 */
export function getServerTargets(config: ShipnodeConfig): ServerTarget[] {
  const declared = Object.entries(config.servers).map(([name, ssh]) => ({ name, ssh }));
  const needs = serverPrerequisites(config);
  if (needs.size === 0) return declared;

  const ordered: ServerTarget[] = [];
  const placed = new Set<string>();
  const remaining = [...declared];

  while (remaining.length > 0) {
    const ready = remaining.findIndex((target) =>
      [...(needs.get(target.name) ?? [])].every((dep) => placed.has(dep) || !config.servers[dep]),
    );
    // -1 means everything left is in a cycle; take the first to stay deterministic.
    const [next] = remaining.splice(ready === -1 ? 0 : ready, 1);
    if (!next) break;
    ordered.push(next);
    placed.add(next.name);
  }

  return ordered;
}

export function getAppsForServer(config: ShipnodeConfig, serverName: string): ShipnodeApp[] {
  return config.apps.filter((app) => resolveServerName(config, app.on) === serverName);
}

export function getAccessoriesForServer(config: ShipnodeConfig, serverName: string): Record<string, AccessoryConfig> {
  const entries = Object.entries(config.accessories ?? {})
    .filter(([, accessory]) => resolveServerName(config, accessory.on) === serverName);
  return Object.fromEntries(entries);
}

/**
 * Managed services are provisioned on exactly one server. Returning the config
 * verbatim would hand `database`/`redis` to every scoped config, and `setup`
 * would then install Postgres once per host — same user, same database name.
 */
function serviceForServer<T extends { on?: string }>(
  config: ShipnodeConfig,
  service: T | undefined,
  serverName: string,
): T | undefined {
  if (!service) return undefined;
  return resolveServerName(config, service.on) === serverName ? service : undefined;
}

export function configForServer(config: ShipnodeConfig, serverName: string): ShipnodeConfig {
  const ssh = getServerTarget(config, serverName).ssh;
  return {
    ...config,
    ssh,
    apps: getAppsForServer(config, serverName),
    accessories: getAccessoriesForServer(config, serverName),
    database: serviceForServer(config, config.database, serverName),
    redis: serviceForServer(config, config.redis, serverName),
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

import { Result, type Result as ResultType } from 'better-result';
import type { AccessoryConfig, ShipnodeApp, ShipnodeConfig, SshConfig } from '../shared/types.js';
import {
  AmbiguousServerTargetError,
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

/**
 * The minimum a config needs to expose for target expansion. Structural so the
 * schema can call this mid-parse, before a `ShipnodeConfig` exists.
 */
export interface ServerTargetSource {
  servers: Record<string, unknown>;
  groups?: Record<string, string[]>;
}

/**
 * Expand an `on` target into server names, in declaration order and deduped.
 *
 * A target may name a server, name a group, or be a list of either. Unknown
 * names are dropped rather than reported — the schema is what tells the user
 * about typos; callers here have already parsed.
 */
export function expandTarget(
  source: ServerTargetSource,
  on: string | string[] | undefined,
): string[] {
  const known = Object.keys(source.servers);

  if (on === undefined) {
    if (known.includes(DEFAULT_SERVER_TARGET)) return [DEFAULT_SERVER_TARGET];
    return known.length === 1 ? [known[0]!] : [];
  }

  const entries = Array.isArray(on) ? on : [on];
  const resolved: string[] = [];

  for (const entry of entries) {
    const group = source.groups?.[entry];
    if (group) {
      resolved.push(...group.filter((member) => known.includes(member)));
      continue;
    }
    if (known.includes(entry)) resolved.push(entry);
  }

  return [...new Set(resolved)];
}

/** Every server an app or accessory runs on. Empty is never returned — it errors. */
export function resolveServerNamesResult(
  config: ShipnodeConfig,
  target?: string | string[],
): ResultType<string[], ServerTargetError> {
  const resolved = expandTarget(config, target);
  if (resolved.length > 0) return Result.ok(resolved);

  if (target === undefined) return Result.err(new MissingServerTargetError());

  const known = Object.keys(config.servers).join(', ') || '(none)';
  const named = Array.isArray(target) ? target.join(', ') : target;
  return Result.err(new UnknownServerTargetError({ target: named, known }));
}

export function resolveServerNames(config: ShipnodeConfig, target?: string | string[]): string[] {
  return resolveServerNamesResult(config, target).unwrap();
}

/**
 * The single server a target names.
 *
 * For things that cannot be replicated (an accessory, a `run` invocation, a
 * watch session) or commands scoped to one box. Resolving to several servers is
 * an error telling the user to disambiguate rather than a silent pick of the
 * first — deploying to the wrong replica is worse than being asked.
 */
export function resolveSingleServerNameResult(
  config: ShipnodeConfig,
  target?: string | string[],
  subject = 'This target',
): ResultType<string, ServerTargetError> {
  const resolved = resolveServerNamesResult(config, target);
  if (resolved.isErr()) return Result.err(resolved.error);

  const [first, ...rest] = resolved.value;
  if (rest.length > 0) {
    return Result.err(new AmbiguousServerTargetError({
      subject,
      servers: resolved.value.join(', '),
    }));
  }
  return Result.ok(first!);
}

export function resolveSingleServerName(
  config: ShipnodeConfig,
  target?: string | string[],
  subject?: string,
): string {
  return resolveSingleServerNameResult(config, target, subject).unwrap();
}

export function getServerTarget(config: ShipnodeConfig, target?: string | string[]): ServerTarget {
  return getServerTargetResult(config, target).unwrap();
}

/** The one server a target names, with its SSH config. Errors if it names several. */
export function getServerTargetResult(
  config: ShipnodeConfig,
  target?: string | string[],
  subject?: string,
): ResultType<ServerTarget, ServerTargetError> {
  const resolved = resolveSingleServerNameResult(config, target, subject);
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
    const appServers = expandTarget(config, app.on);
    for (const name of app.dependsOn ?? []) {
      const accessory = config.accessories?.[name];
      if (!accessory) continue;
      const [accessoryServer] = expandTarget(config, accessory.on);
      if (!accessoryServer) continue;

      for (const appServer of appServers) {
        if (accessoryServer === appServer) continue;
        const existing = needs.get(appServer) ?? new Set<string>();
        existing.add(accessoryServer);
        needs.set(appServer, existing);
      }
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

/** Apps running on this server. A fleet app appears under each of its replicas. */
export function getAppsForServer(config: ShipnodeConfig, serverName: string): ShipnodeApp[] {
  return config.apps.filter((app) => expandTarget(config, app.on).includes(serverName));
}

export function getAccessoriesForServer(
  config: ShipnodeConfig,
  serverName: string,
): Record<string, AccessoryConfig> {
  const entries = Object.entries(config.accessories ?? {})
    .filter(([, accessory]) => expandTarget(config, accessory.on).includes(serverName));
  return Object.fromEntries(entries);
}

/**
 * Managed services are provisioned on exactly one server. Returning the config
 * verbatim would hand `database`/`redis` to every scoped config, and `setup`
 * would then install Postgres once per host — same user, same database name.
 */
function serviceForServers<T extends { on?: string }>(
  config: ShipnodeConfig,
  service: T | undefined,
  serverNames: string[],
): T | undefined {
  if (!service) return undefined;
  const [host] = expandTarget(config, service.on);
  return host !== undefined && serverNames.includes(host) ? service : undefined;
}

export function configForServer(config: ShipnodeConfig, serverName: string): ShipnodeConfig {
  const ssh = getServerTarget(config, serverName).ssh;
  return {
    ...config,
    ssh,
    apps: getAppsForServer(config, serverName),
    accessories: getAccessoriesForServer(config, serverName),
    database: serviceForServers(config, config.database, [serverName]),
    redis: serviceForServers(config, config.redis, [serverName]),
  };
}

export function configForApp(config: ShipnodeConfig, appName: string): ShipnodeConfig {
  return configForAppResult(config, appName).unwrap();
}

/**
 * The workspace narrowed to one app: just that app, and just the servers it
 * runs on. `ssh` points at the first of them, so single-server callers keep
 * working unchanged; fleet-aware callers read the replica list off `servers`
 * via {@link getServerTargets}.
 */
export function configForAppResult(
  config: ShipnodeConfig,
  appName: string,
): ResultType<ShipnodeConfig, AppTargetError> {
  const app = config.apps.find((candidate) => candidate.name === appName);
  if (!app) {
    return Result.err(new UnknownAppError({ name: appName }));
  }

  const names = resolveServerNamesResult(config, app.on);
  if (names.isErr()) return Result.err(names.error);

  const servers = Object.fromEntries(
    names.value.flatMap((name) => {
      const ssh = config.servers[name];
      return ssh ? [[name, ssh] as const] : [];
    }),
  );

  const first = names.value[0]!;
  const accessories = Object.fromEntries(
    Object.entries(config.accessories ?? {})
      .filter(([, accessory]) => {
        const [host] = expandTarget(config, accessory.on);
        return host !== undefined && names.value.includes(host);
      }),
  );

  return Result.ok({
    ...config,
    ssh: servers[first]!,
    servers,
    apps: [app],
    accessories,
    database: serviceForServers(config, config.database, names.value),
    redis: serviceForServers(config, config.redis, names.value),
  });
}

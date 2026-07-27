import type { AccessoryConfig, ShipnodeConfig } from '../shared/types.js';
import { expandTarget } from './servers.js';

/**
 * Reaching an accessory that lives on another server.
 *
 * Docker networks are host-local, so `--network shipnode-private` connects
 * nothing across machines and the container name resolves nowhere. On one box
 * `localhost` happens to work and hides the problem; split the app and its
 * database across two servers and every connection string silently points at
 * the wrong machine.
 *
 * shipnode's answer is a declared address, not discovery: each server may
 * declare a `privateHost`, and every app is handed
 * `SHIPNODE_<ACCESSORY>_HOST` for each accessory it depends on. Co-located
 * accessories get `127.0.0.1`, remote ones get the host's `privateHost`, so the
 * app reads the same variable either way and moving an accessory to its own
 * server is a config change rather than a code change.
 */

/** `postgres` → `SHIPNODE_POSTGRES_HOST`. */
export function accessoryHostVar(accessoryName: string): string {
  return `SHIPNODE_${accessoryName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_HOST`;
}

/** The loopback address an app uses for an accessory on its own server. */
export const LOCAL_ACCESSORY_HOST = '127.0.0.1';

/**
 * Whether every published port of this accessory is bound to loopback.
 *
 * Docker's `-p` accepts `containerPort`, `host:container`, and
 * `bindIp:host:container`. Only the three-part form can restrict the bind, so
 * anything shorter is reachable from off-box. A loopback bind is the right
 * default for a same-server accessory and unreachable for a cross-server one,
 * which is the case worth reporting.
 */
export function isLoopbackOnly(accessory: AccessoryConfig): boolean {
  const ports = accessory.port === undefined
    ? []
    : Array.isArray(accessory.port) ? accessory.port : [accessory.port];
  if (ports.length === 0) return false;

  return ports.every((mapping) => {
    const parts = String(mapping).split(':');
    if (parts.length < 3) return false;
    // The last two segments are always hostPort:containerPort; everything before
    // is the bind address, which for IPv6 is bracketed and full of colons.
    const bind = parts.slice(0, -2).join(':').replace(/^\[|\]$/g, '');
    return bind === 'localhost' || bind === '::1' || bind.startsWith('127.');
  });
}

/**
 * The `SHIPNODE_<NAME>_HOST` variables one app should be given.
 *
 * `hostOf` resolves an accessory to the server it runs on; returning undefined
 * means the accessory is unplaceable and is skipped rather than injected with a
 * wrong address.
 */
export function accessoryHostEnv(
  dependsOn: string[] | undefined,
  appServers: string[],
  resolve: (accessoryName: string) => { server: string; privateHost?: string } | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const name of dependsOn ?? []) {
    const placement = resolve(name);
    if (!placement) continue;

    // Co-located with every replica of this app: loopback is both correct and
    // the tighter bind, so prefer it over the private address.
    if (appServers.length > 0 && appServers.every((server) => server === placement.server)) {
      env[accessoryHostVar(name)] = LOCAL_ACCESSORY_HOST;
      continue;
    }

    if (placement.privateHost) env[accessoryHostVar(name)] = placement.privateHost;
  }

  return env;
}

/** One `ufw allow` worth of intent. `from` undefined means from anywhere. */
export interface FirewallRule {
  port: number;
  from?: string;
  comment: string;
  /**
   * Whether the listener is a Docker published port.
   *
   * Docker inserts its own ACCEPT rules into the FORWARD path, which are
   * evaluated before ufw's — so `ufw allow from X to any port 5432` does not
   * restrict a container's port at all, and the port stays open to everything.
   * Rules flagged here get an additional DOCKER-USER entry, the one chain Docker
   * guarantees to consult first.
   */
  docker?: boolean;
}

/** The host-side port of a Docker `-p` mapping, if it publishes one. */
function publishedHostPort(mapping: string): number | undefined {
  const parts = mapping.split(':');
  // `containerPort` alone gets an ephemeral host port, which no rule can name.
  if (parts.length < 2) return undefined;
  const port = Number(parts[parts.length - 2]);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

/**
 * Firewall rules a server needs because of how the workspace is laid out.
 *
 * Two things stop working the moment an app is split across servers. A replica
 * serves plain HTTP on `fleet.port` for the load balancer to reach, and an
 * accessory has to accept connections from the servers whose apps depend on it.
 * Both are holes `ufw default deny incoming` closes.
 *
 * Accessory rules name the consuming server's `privateHost` rather than opening
 * the port outright — a database reachable from the whole internet is a worse
 * outcome than one that is unreachable.
 */
export function fleetFirewallRules(config: ShipnodeConfig, serverName: string): FirewallRule[] {
  const rules: FirewallRule[] = [];
  const seen = new Set<string>();

  const add = (rule: FirewallRule): void => {
    const key = `${rule.port}|${rule.from ?? '*'}`;
    if (seen.has(key)) return;
    seen.add(key);
    rules.push(rule);
  };

  for (const app of config.apps) {
    const replicas = expandTarget(config, app.on);
    if (!app.fleet || !replicas.includes(serverName)) continue;
    // 80 and 443 are already opened by the base rules.
    if (app.fleet.port === 80 || app.fleet.port === 443) continue;
    add({
      port: app.fleet.port,
      comment: `shipnode ${app.name} replica port`,
    });
  }

  for (const [name, accessory] of Object.entries(config.accessories ?? {})) {
    if (!expandTarget(config, accessory.on).includes(serverName)) continue;

    const mappings = accessory.port === undefined
      ? []
      : Array.isArray(accessory.port) ? accessory.port : [accessory.port];
    const ports = mappings.map(publishedHostPort).filter((p): p is number => p !== undefined);
    if (ports.length === 0) continue;

    // Only apps on *other* servers need a hole; a co-located app reaches it over
    // loopback, which the firewall does not police.
    const consumers = new Set<string>();
    for (const app of config.apps) {
      if (!app.dependsOn?.includes(name)) continue;
      for (const replica of expandTarget(config, app.on)) {
        if (replica === serverName) continue;
        const privateHost = config.servers[replica]?.privateHost;
        if (privateHost) consumers.add(privateHost);
      }
    }

    for (const port of ports) {
      for (const from of consumers) {
        add({ port, from, comment: `shipnode ${name} accessory`, docker: true });
      }
    }
  }

  return rules;
}

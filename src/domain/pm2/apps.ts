import type { ShipnodeConfig, Pm2App } from '../../shared/types.js';

/**
 * The deployment-level PM2 namespace — shared by every supervised process.
 *
 * Equals `apps[0].name` by construction (the builder's `.pm2(name, ...)` sugar
 * always lands on the first app). CLI verbs target this string to operate on
 * the whole deployment at once (`pm2 reload <namespace>`, `pm2 stop <namespace>`).
 */
export function getDeploymentName(config: ShipnodeConfig): string | undefined {
  return config.pm2?.apps[0]?.name;
}

/**
 * The web app — the single `pm2.apps` entry with a `port`, if any.
 *
 * Returns undefined for worker-only deployments. Callers that need the HTTP
 * surface (Caddy, Cloudflare firewall, deploy summary) should treat undefined
 * as "no public HTTP for this deployment" rather than defaulting to a port.
 */
export function getWebApp(config: ShipnodeConfig): Pm2App | undefined {
  return config.pm2?.apps.find((a) => a.port !== undefined);
}

/**
 * Absolute path to the active ecosystem file, stable across rollbacks because
 * `current` is a symlink. Per ADR-0001 the file lives inside each release.
 */
export function getEcosystemPath(config: ShipnodeConfig): string {
  return `${config.remotePath}/current/ecosystem.config.cjs`;
}

/**
 * The name PM2 sees for a given app.
 *
 * PM2's flat global namespace means two deployments on the same host with a
 * worker called `mailer` would collide. We avoid that by prefixing every app's
 * name with the deployment namespace — except for the app whose name already
 * equals the namespace (the web app in a typical deployment), which stays
 * unprefixed to keep `pm2 list` readable and to preserve backward compat with
 * pre-multi-process deploys where the single app's name was the namespace.
 */
export function getPm2Name(namespace: string, appName: string): string {
  return appName === namespace ? appName : `${namespace}-${appName}`;
}

/**
 * Resolve a user-typed short name (`--process mailer`) to the PM2-level name
 * (`api-mailer`). Throws if no matching app is declared — better to surface a
 * typo than to silently no-op `pm2 reload` against a name that doesn't exist.
 */
export function resolveProcessTarget(config: ShipnodeConfig, shortName: string): string {
  const namespace = getDeploymentName(config);
  if (!namespace) throw new Error(`Cannot resolve '${shortName}': no PM2 apps configured.`);
  const match = config.pm2?.apps.find((a) => a.name === shortName);
  if (!match) {
    const names = config.pm2?.apps.map((a) => a.name).join(', ') ?? '';
    throw new Error(`No PM2 app named '${shortName}' in this deployment. Known apps: ${names}`);
  }
  return getPm2Name(namespace, match.name);
}

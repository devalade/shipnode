import type { ShipnodeConfig, ShipnodeApp, Pm2App } from '../../shared/types.js';
import { getActiveApp } from '../workspace.js';

function getPm2Config(config: ShipnodeConfig): ShipnodeApp['pm2'] {
  return getActiveApp(config).pm2;
}

/**
 * The deployment-level PM2 namespace — shared by every supervised process.
 *
 * Equals `apps[0].name` by construction (the builder's `.pm2(name, ...)` sugar
 * always lands on the first app). CLI verbs target this string to operate on
 * the whole deployment at once (`pm2 reload <namespace>`, `pm2 stop <namespace>`).
 */
export function getDeploymentName(config: ShipnodeConfig): string | undefined {
  return getPm2Config(config)?.apps[0]?.name;
}

export function getWebApp(config: ShipnodeConfig): Pm2App | undefined {
  return getPm2Config(config)?.apps.find((a) => a.port !== undefined);
}

/**
 * Absolute path to the active ecosystem file, stable across rollbacks because
 * `current` is a symlink. Per ADR-0001 the file lives inside each release.
 */
export function getEcosystemPath(config: ShipnodeConfig, appName?: string): string {
  const root = appName ? `${config.remotePath}/${appName}` : config.remotePath;
  return `${root}/current/ecosystem.config.cjs`;
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
  const pm2Config = getPm2Config(config);
  const namespace = getDeploymentName(config);
  if (!namespace) throw new Error(`Cannot resolve '${shortName}': no PM2 apps configured.`);
  const match = pm2Config?.apps.find((a) => a.name === shortName);
  if (!match) {
    const names = pm2Config?.apps.map((a) => a.name).join(', ') ?? '';
    throw new Error(`No PM2 app named '${shortName}' in this deployment. Known apps: ${names}`);
  }
  return getPm2Name(namespace, match.name);
}

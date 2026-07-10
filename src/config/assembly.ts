import type { ShipnodeConfig, Pm2App, Pm2Config, ShipnodeApp } from '../shared/types.js';
import { ShipnodeConfigSchema } from './schema.js';

// Loose input shape: also accepts the pre-multi-process `pm2: { name, instances, maxMemory }`
// + top-level `backend: { port }` form, which assembleConfig folds into pm2.apps[0].
type LegacyPm2Input = {
  name?: string;
  instances?: number;
  maxMemory?: string;
  apps?: Pm2App[];
};

type AssembleInput = {
  ssh?: ShipnodeConfig['ssh'];
  servers?: ShipnodeConfig['servers'];
  remotePath?: string;
  nodeVersion?: string;
  pkgManager?: ShipnodeConfig['pkgManager'];
  installCommand?: string;
  database?: ShipnodeConfig['database'];
  redis?: ShipnodeConfig['redis'];
  backup?: ShipnodeConfig['backup'];
  cloudflare?: ShipnodeConfig['cloudflare'];
  aliases?: Record<string, string>;
  registry?: ShipnodeConfig['registry'];
  accessories?: ShipnodeConfig['accessories'];
  // Legacy input fields — synthesized to apps[0] by z.preprocess
  app?: string;
  on?: string;
  domain?: string;
  caddy?: ShipnodeApp['caddy'];
  pm2?: LegacyPm2Input | Pm2Config;
  backend?: { port?: number };
  healthCheck?: unknown;
  envFile?: string;
  keepReleases?: number;
  sharedDirs?: string[];
  sharedFiles?: string[];
  buildDir?: string;
  appRoot?: string;
  hooks?: unknown;
  apps?: Partial<ShipnodeApp>[];
};

function normalizePm2(
  pm2: LegacyPm2Input | Pm2Config | undefined,
  backend: { port?: number } | undefined,
): Pm2Config | undefined {
  if (!pm2) return undefined;
  if ('apps' in pm2 && pm2.apps) {
    return { apps: pm2.apps };
  }
  const legacy = pm2 as LegacyPm2Input;
  if (!legacy.name) return undefined;
  const app: Pm2App = { name: legacy.name };
  if (legacy.instances !== undefined) app.instances = legacy.instances;
  if (legacy.maxMemory !== undefined) app.maxMemory = legacy.maxMemory;
  if (backend?.port !== undefined) app.port = backend.port;
  return { apps: [app] };
}

/**
 * Assemble a partial config into a fully-validated ShipnodeConfig.
 *
 * The schema is the single source of truth — it knows about defaults, refinements, and
 * the legacy-fields-to-apps[0] synthesis (via its z.preprocess wrapper). assembleConfig
 * only does what the schema cannot: normalize the legacy `pm2: { name }` input shape
 * onto canonical `pm2.apps`.
 */
export function assembleConfig(partial: AssembleInput): ShipnodeConfig {
  const { backend, ...rest } = partial;
  const pm2 = normalizePm2(rest.pm2, backend);

  return ShipnodeConfigSchema.parse({ ...rest, pm2 });
}

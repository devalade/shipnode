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

type AssembleInput = Omit<Partial<ShipnodeConfig>, 'pm2' | 'apps'> & {
  pm2?: LegacyPm2Input | Pm2Config;
  backend?: { port?: number };
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
 * only does what the schema cannot:
 *
 *  1. Normalize the legacy `pm2: { name }` input shape onto canonical `pm2.apps`.
 *  2. After parse, mirror `apps[0].<field>` back onto the legacy top-level fields so
 *     downstream code still reading `config.domain`, `config.pm2`, etc. keeps working
 *     during the 3.0 transition. Sprint 2c will migrate downstream consumers to read
 *     from `apps[]`, after which the mirror can be removed.
 */
export function assembleConfig(partial: AssembleInput): ShipnodeConfig {
  const { backend, ...rest } = partial;
  const pm2 = normalizePm2(rest.pm2, backend);

  const parsed = ShipnodeConfigSchema.parse({ ...rest, pm2 });

  // Force legacy top-level mirrors to match apps[0]: when the user mixed both shapes,
  // apps wins; when the user only used legacy top-level fields, this is a no-op.
  const first = parsed.apps[0];
  return {
    ...parsed,
    app: first.appType,
    pm2: first.pm2,
    domain: first.domain,
    healthCheck: first.healthCheck,
    envFile: first.envFile,
    keepReleases: first.keepReleases,
    sharedDirs: first.sharedDirs,
    sharedFiles: first.sharedFiles,
    buildDir: first.buildDir,
    appRoot: first.appRoot,
    hooks: first.hooks,
  } as ShipnodeConfig;
}

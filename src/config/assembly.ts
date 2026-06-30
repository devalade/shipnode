import type { ShipnodeConfig, Pm2App, Pm2Config } from '../shared/types.js';
import { ShipnodeConfigSchema } from './schema.js';

// Loose input shape: also accepts the pre-multi-process `pm2: { name, instances, maxMemory }`
// + top-level `backend: { port }` form, which assembleConfig folds into pm2.apps[0].
type LegacyPm2Input = {
  name?: string;
  instances?: number;
  maxMemory?: string;
  apps?: Pm2App[];
};

type AssembleInput = Omit<Partial<ShipnodeConfig>, 'pm2'> & {
  pm2?: LegacyPm2Input | Pm2Config;
  backend?: { port?: number };
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
 * The schema is the single source of truth: all defaults, validation, and refinements
 * live there. assembleConfig only does what the schema cannot — normalize the legacy
 * pm2/backend input shape onto canonical pm2.apps — then hands the rest to zod parse.
 * Every field declared in the schema is preserved automatically; adding a new field
 * to the schema (and its corresponding builder method) requires no change here.
 */
export function assembleConfig(partial: AssembleInput): ShipnodeConfig {
  const { backend, ...rest } = partial;
  const pm2 = normalizePm2(partial.pm2, backend);
  return ShipnodeConfigSchema.parse({ ...rest, pm2 }) as ShipnodeConfig;
}

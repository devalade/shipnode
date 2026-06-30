import type {
  ShipnodeConfig,
  SshConfig,
  HealthCheckConfig,
  Pm2App,
  Pm2Config,
} from '../shared/types.js';
import { ShipnodeConfigSchema } from './schema.js';
import { DEFAULTS } from '../shared/constants.js';

function defaultSshConfig(overrides?: Partial<SshConfig>): SshConfig {
  return {
    host: '',
    user: '',
    port: DEFAULTS.SSH_PORT,
    ...overrides,
  };
}

function defaultHealthCheckConfig(overrides?: Partial<HealthCheckConfig>): HealthCheckConfig {
  return {
    enabled: DEFAULTS.HEALTH_CHECK_ENABLED,
    path: DEFAULTS.HEALTH_CHECK_PATH,
    timeout: DEFAULTS.HEALTH_CHECK_TIMEOUT,
    retries: DEFAULTS.HEALTH_CHECK_RETRIES,
    startupDelay: DEFAULTS.HEALTH_CHECK_STARTUP_DELAY,
    ...overrides,
  };
}

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
 * Single boundary between user intent and trusted config. Accepts both the legacy
 * `pm2: { name } + backend: { port }` shape and the canonical `pm2: { apps: [...] }`
 * shape; emits the canonical shape only.
 */
export function assembleConfig(partial: AssembleInput): ShipnodeConfig {
  const pm2 = normalizePm2(partial.pm2, partial.backend);

  const withDefaults = {
    app: partial.app ?? 'backend',
    ssh: partial.ssh ?? defaultSshConfig(),
    remotePath: partial.remotePath ?? '/var/www/app',
    pm2,
    domain: partial.domain,
    keepReleases: partial.keepReleases ?? DEFAULTS.KEEP_RELEASES,
    healthCheck: defaultHealthCheckConfig(partial.healthCheck),
    envFile: partial.envFile ?? DEFAULTS.ENV_FILE,
    nodeVersion: partial.nodeVersion ?? DEFAULTS.NODE_VERSION,
    pkgManager: partial.pkgManager,
    installCommand: partial.installCommand,
    sharedDirs: partial.sharedDirs,
    sharedFiles: partial.sharedFiles,
    buildDir: partial.buildDir,
    appRoot: partial.appRoot,
    database: partial.database,
    redis: partial.redis,
    backup: partial.backup,
    cloudflare: partial.cloudflare,
    hooks: partial.hooks,
    aliases: partial.aliases,
  };

  return ShipnodeConfigSchema.parse(withDefaults) as ShipnodeConfig;
}

import type { ShipnodeConfig, SshConfig, BackendConfig, HealthCheckConfig } from '../shared/types.js';
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

function defaultBackendConfig(overrides?: Partial<BackendConfig>): BackendConfig {
  return {
    port: DEFAULTS.BACKEND_PORT,
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

/**
 * Assemble a partial config into a fully-validated ShipnodeConfig.
 *
 * This is the single place where raw user intent becomes a trusted
 * configuration object. Defaults are applied first, then the schema
 * validates every field.
 *
 * Both the builder and the loader must route through here so that
 * defaults and validation are identical regardless of how the config
 * was produced.
 */
export function assembleConfig(partial: Partial<ShipnodeConfig>): ShipnodeConfig {
  const withDefaults = {
    app: partial.app ?? 'backend',
    ssh: partial.ssh ?? defaultSshConfig(),
    remotePath: partial.remotePath ?? '/var/www/app',
    pm2: partial.pm2,
    backend: partial.backend ?? defaultBackendConfig(),
    domain: partial.domain,
    zeroDowntime: partial.zeroDowntime ?? DEFAULTS.ZERO_DOWNTIME,
    keepReleases: partial.keepReleases ?? DEFAULTS.KEEP_RELEASES,
    healthCheck: defaultHealthCheckConfig(partial.healthCheck),
    envFile: partial.envFile ?? DEFAULTS.ENV_FILE,
    nodeVersion: partial.nodeVersion ?? DEFAULTS.NODE_VERSION,
    pkgManager: partial.pkgManager,
    sharedDirs: partial.sharedDirs,
    sharedFiles: partial.sharedFiles,
    database: partial.database,
    hooks: partial.hooks,
  };

  return ShipnodeConfigSchema.parse(withDefaults);
}

export { shipnode, defineConfig } from './config/builder.js';
export type { ShipnodeConfig, SshConfig, Pm2Config, BackendConfig, HealthCheckConfig, DatabaseConfig, HookContext, HookFn, AppType, PkgManager } from './shared/types.js';
export { loadConfig } from './config/loader.js';
export { detectFramework, detectPkgManager, parsePackageJson } from './domain/framework/detector.js';
export type { FrameworkDetectionResult } from './shared/types.js';

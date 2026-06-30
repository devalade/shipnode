export { shipnode, app, defineConfig, ShipnodeAppBuilder } from './config/builder.js';
export type { ShipnodeConfig, ShipnodeApp, SshConfig, Pm2Config, Pm2App, HealthCheckConfig, DatabaseConfig, HookContext, HookFn, AppType, PkgManager } from './shared/types.js';
export { loadConfig } from './config/loader.js';
export { detectFramework, detectPkgManager, parsePackageJson } from './domain/framework/detector.js';
export type { FrameworkDetectionResult } from './shared/types.js';

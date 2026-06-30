export type AppType = 'backend' | 'frontend';

export type PkgManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

export type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'mongodb';

export interface SqliteDatabaseConfig {
  type: 'sqlite';
  name: string;
}

export interface NetworkDatabaseConfig {
  type: 'postgres' | 'mysql' | 'mongodb';
  host: string;
  port: number;
  name: string;
  user: string;
  password?: string;
}

export interface SshConfig {
  host: string;
  user: string;
  port: number;
  identityFile?: string;
  proxyMode?: 'cloudflare';
  proxyCommand?: string;
}

export interface Pm2App {
  name: string;
  command?: string;
  instances?: number;
  maxMemory?: string;
  port?: number;
  env?: Record<string, string>;
}

export interface Pm2Config {
  apps: Pm2App[];
}

export interface HealthCheckConfig {
  enabled: boolean;
  path: string;
  timeout: number;
  retries: number;
  startupDelay: number;
}

export type DatabaseConfig = SqliteDatabaseConfig | NetworkDatabaseConfig;

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
}

export interface BackupConfig {
  s3Bucket: string;
  s3Prefix?: string;
  s3Endpoint?: string;
  schedule?: 'hourly' | 'daily' | 'weekly';
  retentionDays?: number;
}

export interface CloudflareConfig {
  zone: string;
  sshHostname?: string;
  tunnelName?: string;
  lockdownFirewall?: boolean;
  accessEmails?: string[];
  bootstrapSshHost?: string;
}

export interface HookContext {
  config: ShipnodeConfig;
  release?: string;
  env: string;
  exec(cmd: string, options?: ExecOptions): Promise<ExecResult>;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type HookFn = (ctx: HookContext) => Promise<void> | void;

export interface HooksConfig {
  preDeploy?: HookFn;
  postDeploy?: HookFn;
}

/**
 * A single deployment unit (a "deploy unit" in ADR 0004 terminology). A workspace
 * declares one or more of these; each has its own release directory, PM2 process
 * group, Caddy site, and Cloudflare ingress entry.
 */
export interface ShipnodeApp {
  name: string;
  appType: AppType;
  appRoot?: string;
  domain?: string;
  pm2?: Pm2Config;
  healthCheck: HealthCheckConfig;
  envFile: string;
  keepReleases: number;
  sharedDirs?: string[];
  sharedFiles?: string[];
  buildDir?: string;
  hooks?: HooksConfig;
}

export interface ShipnodeConfig {
  // workspace-level
  ssh: SshConfig;
  remotePath: string;
  nodeVersion: string;
  pkgManager?: PkgManager;
  /** Override the install command run on the server. Defaults to the package manager's standard install (e.g. `npm ci`). Use to add flags like `--legacy-peer-deps`, switch to a frozen-lockfile variant, etc. */
  installCommand?: string;
  database?: DatabaseConfig;
  redis?: RedisConfig;
  backup?: BackupConfig;
  cloudflare?: CloudflareConfig;
  aliases?: Record<string, string>;

  /** Canonical app list. Always populated by assembleConfig (length >= 1). */
  apps: ShipnodeApp[];
}

export interface ReleaseRecord {
  timestamp: string;
  status: 'success' | 'failed';
  duration: number;
  gitCommit?: string;
  healthAttempts?: number;
  healthResponseMs?: number;
  previousRelease?: string;
}

export interface FrameworkDetectionResult {
  name: string;
  appType: AppType | 'unknown';
  port?: number;
  orm?: string;
}

export interface DeployContext {
  config: ShipnodeConfig;
  ssh: import('../infrastructure/ssh/connection.js').SshConnection;
  releasePath: string;
  previousRelease?: string;
  gitCommit?: string;
  deployStart: number;
}

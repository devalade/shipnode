export type AppType = 'backend' | 'frontend';

export type PkgManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

export type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'mongodb';

export interface SshConfig {
  host: string;
  user: string;
  port: number;
  identityFile?: string;
  proxyMode?: 'cloudflare';
  proxyCommand?: string;
}

export interface Pm2Config {
  name: string;
  instances?: number;
  maxMemory?: string;
}

export interface BackendConfig {
  port: number;
}

export interface HealthCheckConfig {
  enabled: boolean;
  path: string;
  timeout: number;
  retries: number;
  startupDelay: number;
}

export interface DatabaseConfig {
  type: DatabaseType;
  host: string;
  port: number;
  name: string;
  user: string;
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
  appHostname?: string;
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

export interface ShipnodeConfig {
  app: AppType;
  ssh: SshConfig;
  remotePath: string;
  pm2?: Pm2Config;
  backend?: BackendConfig;
  domain?: string;
  zeroDowntime: boolean;
  keepReleases: number;
  healthCheck: HealthCheckConfig;
  envFile: string;
  nodeVersion: string;
  pkgManager?: PkgManager;
  buildDir?: string;
  sharedDirs?: string[];
  sharedFiles?: string[];
  database?: DatabaseConfig;
  backup?: BackupConfig;
  cloudflare?: CloudflareConfig;
  hooks?: HooksConfig;
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

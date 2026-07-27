export type AppType = 'backend' | 'frontend';
export type BlueGreenRetention = 'rollback' | 'none';

export type PkgManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

export type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'mongodb';

export interface SqliteDatabaseConfig {
  type: 'sqlite';
  /**
   * Which server hosts this database. Provisioning (`shipnode setup`) only runs
   * on that server; every other server's scoped config drops the field. Omitted,
   * it resolves the same way an app's `on` does — `default`, or the sole server.
   */
  on?: string;
  name: string;
}

export interface NetworkDatabaseConfig {
  type: 'postgres' | 'mysql' | 'mongodb';
  /** Which server hosts this database. See {@link SqliteDatabaseConfig.on}. */
  on?: string;
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
  /**
   * The address other servers and the load balancer use to reach this box —
   * typically a private-network IP. SSH still connects over `host`. Required
   * for every server a fleet app runs on, since the LB has to reach each
   * replica directly.
   */
  privateHost?: string;
  identityFile?: string;
  proxyMode?: 'cloudflare';
  proxyCommand?: string;
}

/**
 * How an app is rolled across the servers it runs on.
 *
 * shipnode does not manage the load balancer. It owns one thing — a readiness
 * endpoint that answers 200 normally and 503 while a replica is being
 * deployed — and relies on the LB's own health check to pull that replica out
 * of rotation and put it back.
 */
export interface FleetConfig {
  /** Replicas updated at a time. 1 (the default) is the safest roll. */
  batch: number;
  /** Port replicas serve on. TLS terminates at the load balancer, not here. */
  port: number;
  /**
   * Seconds to wait after flipping the readiness endpoint to 503 before
   * touching the app.
   *
   * shipnode cannot know your LB's health-check interval or unhealthy
   * threshold, so it cannot detect when traffic has actually stopped. This is
   * the one number you must match to your LB: too low and the roll drops
   * requests that were already in flight.
   */
  drainWait: number;
  /** Path the load balancer's health check polls. */
  readyPath: string;
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

export interface DockerConfig {
  image?: string;
  dockerfile: string;
  context: string;
  port: number;
  containerPort: number;
  buildArgs?: Record<string, string>;
  runArgs?: string[];
}

export interface RegistryConfig {
  server: string;
  username: string;
  passwordEnv: string;
}

export interface AccessoryConfig {
  image: string;
  on?: string;
  port?: string | string[];
  /** Docker `-v` mounts (`named:/path` or `/host:/container`). */
  directories?: string[];
  /**
   * Alias for `directories` (Compose-style name). Prefer `directories`.
   * If both are set, `directories` wins.
   */
  volumes?: string[];
  networks?: string[];
  command?: string | string[];
  labels?: Record<string, string>;
  restart?: 'no' | 'always' | 'unless-stopped' | 'on-failure';
  resources?: {
    memory?: string;
    memoryReservation?: string;
    cpus?: string;
  };
  stopTimeout?: number;
  env?: Record<string, string>;
  registry?: RegistryConfig;
  healthCheck?: {
    command: string;
  };
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
  /** Which server hosts Redis. See {@link SqliteDatabaseConfig.on}. */
  on?: string;
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
  strategy?: 'snapshot' | 'restic';
  keepDaily?: number;
  keepWeekly?: number;
  keepMonthly?: number;
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
  /**
   * Where this app runs: a server name, a group name, or a list of either.
   * Resolving to more than one server makes it a fleet — see {@link fleet}.
   */
  on?: string | string[];
  /**
   * Rolling-deploy settings. Populated by assembly whenever the app resolves to
   * more than one server, or declared explicitly to put a single-server app
   * behind the same drain contract (useful before scaling out).
   */
  fleet?: FleetConfig;
  appRoot?: string;
  domain?: string;
  caddy?: {
    append?: string;
  };
  pm2?: Pm2Config;
  docker?: DockerConfig;
  healthCheck: HealthCheckConfig;
  envFile: string;
  keepReleases: number;
  /**
   * Zero-downtime (blue-green) releases for a backend web app. Defaults to true
   * when the backend has a domain and a PM2 web port. When true the
   * new release boots on the idle colour's port while the old colour keeps
   * serving; Caddy's upstream is flipped only after the health check passes.
   * Requires one pm2 app with a port. See docs/adr and blue-green.ts.
   */
  zeroDowntime: boolean;
  /**
   * What to do with the previously active web process after a successful
   * blue-green switch. `rollback` keeps it available for an instant rollback;
   * `none` stops it immediately to reclaim its memory.
   */
  blueGreenRetention: BlueGreenRetention;
  /**
   * The second port used by blue-green. Blue = the web app's port, green =
   * `altPort` (defaults to an uncommon port offset by 10,000). Both colours may
   * be resident at once, so this port must be free on the host.
   */
  altPort?: number;
  sharedDirs?: string[];
  sharedFiles?: string[];
  buildDir?: string;
  hooks?: HooksConfig;
  dependsOn?: string[];
}

export interface ShipnodeConfig {
  // workspace-level
  ssh: SshConfig;
  servers: Record<string, SshConfig>;
  /** Named sets of servers, usable anywhere a single server name is. */
  groups?: Record<string, string[]>;
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
  registry?: RegistryConfig;
  accessories?: Record<string, AccessoryConfig>;

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

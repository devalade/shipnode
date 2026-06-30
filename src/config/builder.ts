import type {
  ShipnodeConfig,
  ShipnodeApp,
  SshConfig,
  Pm2App,
  HealthCheckConfig,
  DatabaseConfig,
  RedisConfig,
  BackupConfig,
  CloudflareConfig,
  HookFn,
  PkgManager,
} from '../shared/types.js';
import { assembleConfig } from './assembly.js';

type BuilderState = {
  ssh?: SshConfig;
  remotePath?: string;
  nodeVersion?: string;
  pkgManager?: PkgManager;
  installCommand?: string;
  database?: DatabaseConfig;
  redis?: RedisConfig;
  backup?: BackupConfig;
  cloudflare?: CloudflareConfig;
  aliases?: Record<string, string>;
  // Legacy per-app input fields (synthesized to apps[0] by z.preprocess)
  app?: string;
  pm2?: { apps: Pm2App[] };
  domain?: string;
  keepReleases?: number;
  healthCheck?: Partial<HealthCheckConfig>;
  envFile?: string;
  buildDir?: string;
  sharedDirs?: string[];
  sharedFiles?: string[];
  appRoot?: string;
  hooks?: { preDeploy?: HookFn; postDeploy?: HookFn };
  apps?: Partial<ShipnodeApp>[];
};

type AppBuilderState = Omit<Partial<ShipnodeApp>, 'pm2'> & {
  pm2?: { apps: Pm2App[] };
};

export type WorkerOptions = Omit<Pm2App, 'port'>;

export class ShipnodeBuilder {
  private config: BuilderState = {};

  private firstApp(): Pm2App {
    if (!this.config.pm2) this.config.pm2 = { apps: [] };
    if (this.config.pm2.apps.length === 0) this.config.pm2.apps.push({ name: 'app' });
    return this.config.pm2.apps[0];
  }

  backend(): this {
    this.config.app = 'backend';
    return this;
  }

  frontend(): this {
    this.config.app = 'frontend';
    return this;
  }

  ssh(opts: SshConfig): this {
    this.config.ssh = { ...this.config.ssh, ...opts };
    return this;
  }

  cloudflareAccess(proxyCommand?: string): this {
    const existing = this.config.ssh ?? { host: '', user: '', port: 22 };
    this.config.ssh = {
      ...existing,
      proxyMode: 'cloudflare',
      proxyCommand: proxyCommand ?? existing.proxyCommand,
    };
    return this;
  }

  deployTo(path: string): this {
    this.config.remotePath = path;
    return this;
  }

  pm2(name: string, opts?: { instances?: number; maxMemory?: string }): this {
    const app = this.firstApp();
    app.name = name;
    if (opts?.instances !== undefined) app.instances = opts.instances;
    if (opts?.maxMemory !== undefined) app.maxMemory = opts.maxMemory;
    return this;
  }

  port(n: number): this {
    this.firstApp().port = n;
    return this;
  }

  worker(opts: WorkerOptions): this {
    if (!this.config.pm2) this.config.pm2 = { apps: [] };
    this.config.pm2.apps.push({ ...opts });
    return this;
  }

  domain(d: string): this {
    this.config.domain = d;
    return this;
  }

  keepReleases(n: number): this {
    this.config.keepReleases = n;
    return this;
  }

  sharedDirs(dirs: string[]): this {
    this.config.sharedDirs = dirs;
    return this;
  }

  sharedFiles(files: string[]): this {
    this.config.sharedFiles = files;
    return this;
  }

  healthCheck(path: string, opts?: Partial<HealthCheckConfig>): this {
    this.config.healthCheck = {
      ...(this.config.healthCheck ?? {}),
      enabled: true,
      path,
      timeout: opts?.timeout ?? 30,
      retries: opts?.retries ?? 3,
      startupDelay: opts?.startupDelay ?? 3,
    };
    return this;
  }

  noHealthCheck(): this {
    this.config.healthCheck = { enabled: false, path: '/health', timeout: 30, retries: 3, startupDelay: 3 };
    return this;
  }

  envFile(f: string): this {
    this.config.envFile = f;
    return this;
  }

  nodeVersion(v: string): this {
    this.config.nodeVersion = v;
    return this;
  }

  pkgManager(pm: PkgManager, opts?: { installCommand?: string }): this {
    this.config.pkgManager = pm;
    if (opts?.installCommand !== undefined) this.config.installCommand = opts.installCommand;
    return this;
  }

  installCommand(cmd: string): this {
    this.config.installCommand = cmd;
    return this;
  }

  buildDir(dir: string): this {
    this.config.buildDir = dir;
    return this;
  }

  appRoot(dir: string): this {
    this.config.appRoot = dir;
    return this;
  }

  database(opts: DatabaseConfig): this {
    this.config.database = opts;
    return this;
  }

  redis(opts: RedisConfig): this {
    this.config.redis = opts;
    return this;
  }

  backup(opts: BackupConfig): this {
    this.config.backup = opts;
    return this;
  }

  cloudflare(opts: CloudflareConfig): this {
    this.config.cloudflare = opts;
    return this;
  }

  preDeploy(fn: HookFn): this {
    this.config.hooks = { ...(this.config.hooks ?? {}), preDeploy: fn };
    return this;
  }

  postDeploy(fn: HookFn): this {
    this.config.hooks = { ...(this.config.hooks ?? {}), postDeploy: fn };
    return this;
  }

  aliases(map: Record<string, string>): this {
    this.config.aliases = { ...(this.config.aliases ?? {}), ...map };
    return this;
  }

  /**
   * Start a new per-app sub-builder. Pair with `.apps([api, web])` on the workspace
   * builder to declare a multi-app deployment. See docs/adr/0004-workspace-multi-app.md.
   */
  app(): ShipnodeAppBuilder {
    return new ShipnodeAppBuilder();
  }

  /**
   * Declare the apps that compose this workspace. Each app gets its own release
   * directory, PM2 process group, Caddy site, and Cloudflare ingress entry. When
   * `.apps([])` is called, the per-app methods on this root builder (.pm2/.port/
   * .worker/.domain/.healthCheck/.preDeploy/.postDeploy/.appRoot/.envFile/etc.) are
   * ignored — the apps declared here take over. When `.apps([])` is not called, the
   * per-app methods continue to write to an implicit single default app (legacy 2.x
   * behavior). Mixing both is supported but `.apps([])` wins.
   */
  apps(apps: ShipnodeAppBuilder[]): this {
    this.config.apps = apps.map((b) => b.toApp());
    return this;
  }

  build(): ShipnodeConfig {
    return assembleConfig(this.config);
  }
}

/**
 * Per-app builder. Created via `shipnode.app()` or the standalone `app()` factory.
 * Mirrors the per-app subset of the workspace builder. Pass the result to
 * `shipnode.apps([...])` on the workspace builder to compose a multi-app deployment.
 */
export class ShipnodeAppBuilder {
  private state: AppBuilderState = {};

  private firstPm2App(): Pm2App {
    if (!this.state.pm2) this.state.pm2 = { apps: [] };
    if (this.state.pm2.apps.length === 0) this.state.pm2.apps.push({ name: this.state.name ?? 'app' });
    return this.state.pm2.apps[0];
  }

  backend(): this {
    this.state.appType = 'backend';
    return this;
  }

  frontend(): this {
    this.state.appType = 'frontend';
    return this;
  }

  name(n: string): this {
    this.state.name = n;
    return this;
  }

  pm2(name: string, opts?: { instances?: number; maxMemory?: string }): this {
    const app = this.firstPm2App();
    app.name = name;
    if (opts?.instances !== undefined) app.instances = opts.instances;
    if (opts?.maxMemory !== undefined) app.maxMemory = opts.maxMemory;
    return this;
  }

  port(n: number): this {
    this.firstPm2App().port = n;
    return this;
  }

  worker(opts: WorkerOptions): this {
    if (!this.state.pm2) this.state.pm2 = { apps: [] };
    this.state.pm2.apps.push({ ...opts });
    return this;
  }

  domain(d: string): this {
    this.state.domain = d;
    return this;
  }

  appRoot(dir: string): this {
    this.state.appRoot = dir;
    return this;
  }

  envFile(f: string): this {
    this.state.envFile = f;
    return this;
  }

  keepReleases(n: number): this {
    this.state.keepReleases = n;
    return this;
  }

  sharedDirs(dirs: string[]): this {
    this.state.sharedDirs = dirs;
    return this;
  }

  sharedFiles(files: string[]): this {
    this.state.sharedFiles = files;
    return this;
  }

  buildDir(dir: string): this {
    this.state.buildDir = dir;
    return this;
  }

  healthCheck(path: string, opts?: Partial<HealthCheckConfig>): this {
    this.state.healthCheck = {
      ...(this.state.healthCheck ?? {}),
      enabled: true,
      path,
      timeout: opts?.timeout ?? 30,
      retries: opts?.retries ?? 3,
      startupDelay: opts?.startupDelay ?? 3,
    };
    return this;
  }

  noHealthCheck(): this {
    this.state.healthCheck = { enabled: false, path: '/health', timeout: 30, retries: 3, startupDelay: 3 };
    return this;
  }

  preDeploy(fn: HookFn): this {
    this.state.hooks = { ...(this.state.hooks ?? {}), preDeploy: fn };
    return this;
  }

  postDeploy(fn: HookFn): this {
    this.state.hooks = { ...(this.state.hooks ?? {}), postDeploy: fn };
    return this;
  }

  /** Internal: hand off the accumulated state to the workspace builder. */
  toApp(): Partial<ShipnodeApp> {
    return this.state as Partial<ShipnodeApp>;
  }
}

export const shipnode = new ShipnodeBuilder();

/** Standalone factory for a per-app sub-builder. Equivalent to `shipnode.app()`. */
export function app(): ShipnodeAppBuilder {
  return new ShipnodeAppBuilder();
}

export function defineConfig(builder: ShipnodeBuilder): ShipnodeBuilder {
  return builder;
}

import type {
  ShipnodeConfig,
  SshConfig,
  Pm2Config,
  HealthCheckConfig,
  DatabaseConfig,
  HookFn,
  PkgManager,
} from '../shared/types.js';
import { assembleConfig } from './assembly.js';

export class ShipnodeBuilder {
  private config: Partial<ShipnodeConfig> = {};

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

  pm2(name: string, opts?: Omit<Pm2Config, 'name'>): this {
    this.config.pm2 = { name, ...opts };
    return this;
  }

  port(n: number): this {
    this.config.backend = { ...(this.config.backend ?? {}), port: n };
    return this;
  }

  domain(d: string): this {
    this.config.domain = d;
    return this;
  }

  zeroDowntime(opts?: { keepReleases?: number }): this {
    this.config.zeroDowntime = true;
    if (opts?.keepReleases !== undefined) {
      this.config.keepReleases = opts.keepReleases;
    }
    return this;
  }

  legacy(): this {
    this.config.zeroDowntime = false;
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

  pkgManager(pm: PkgManager): this {
    this.config.pkgManager = pm;
    return this;
  }

  buildDir(dir: string): this {
    this.config.buildDir = dir;
    return this;
  }

  database(opts: DatabaseConfig): this {
    this.config.database = opts;
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

  build(): ShipnodeConfig {
    return assembleConfig(this.config);
  }
}

export const shipnode = new ShipnodeBuilder();

export function defineConfig(builder: ShipnodeBuilder): ShipnodeBuilder {
  return builder;
}

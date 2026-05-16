import type { ShipnodeConfig } from '../shared/types.js';
import type { RemoteExecutor } from '../domain/remote/executor.js';

export class CaddyService {
  constructor(
    private executor: RemoteExecutor,
    private config: ShipnodeConfig,
  ) {}

  async configureBackend(): Promise<void> {
    if (!this.config.domain || !this.config.pm2) return;

    const port = this.config.backend?.port ?? 3000;
    const appName = this.config.pm2.name;
    const caddyConfig = this.generateBackendCaddyfile(appName, port);

    const escaped = caddyConfig.replace(/'/g, "'\"'\"'");
    await this.executor.exec(`echo '${escaped}' > /etc/caddy/conf.d/${appName}.caddy`);
    await this.executor.exec('systemctl reload caddy');
  }

  async configureFrontend(): Promise<void> {
    if (!this.config.domain) return;

    const servePath = this.config.zeroDowntime
      ? `${this.config.remotePath}/current`
      : this.config.remotePath;

    const appName = this.config.remotePath.split('/').pop() ?? 'app';
    const caddyConfig = this.generateFrontendCaddyfile(appName, servePath);

    const escaped = caddyConfig.replace(/'/g, "'\"'\"'");
    await this.executor.exec(`echo '${escaped}' > /etc/caddy/conf.d/${appName}.caddy`);
    await this.executor.exec('systemctl reload caddy');
  }

  private generateBackendCaddyfile(appName: string, port: number): string {
    return `${this.config.domain} {
    reverse_proxy localhost:${port}

    encode gzip

    log {
        output file /var/log/caddy/${appName}.log
    }
}`;
  }

  private generateFrontendCaddyfile(appName: string, servePath: string): string {
    return `${this.config.domain} {
    root * ${servePath}
    file_server

    try_files {path} /index.html

    encode gzip

    log {
        output file /var/log/caddy/${appName}.log
    }
}`;
  }
}

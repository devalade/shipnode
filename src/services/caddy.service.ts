import type { ShipnodeConfig, ShipnodeApp } from '../shared/types.js';
import { getActiveApp } from '../domain/workspace.js';
import type { RemoteExecutor } from '../domain/remote/executor.js';
import { getDeploymentName, getWebApp } from '../domain/pm2/apps.js';

export class CaddyService {
  constructor(
    private executor: RemoteExecutor,
    private config: ShipnodeConfig,
  ) {}

  private get app(): ShipnodeApp {
    return getActiveApp(this.config);
  }

  async configureBackend(): Promise<void> {
    if (!this.app.domain || !this.app.pm2) return;

    const webApp = getWebApp(this.config);
    const appName = getDeploymentName(this.config);
    // Domain + backend without a web app is rejected by assembleConfig (Q4),
    // so reaching here without a webApp would be a bug — defensive guard.
    if (!webApp || !appName) return;
    const caddyConfig = this.generateBackendCaddyfile(appName, webApp.port!);

    const escaped = caddyConfig.replace(/'/g, "'\"'\"'");
    await this.executor.execOrThrow(`echo '${escaped}' > /etc/caddy/conf.d/${appName}.caddy`);
    await this.executor.execOrThrow('systemctl reload caddy');
  }

  async configureFrontend(): Promise<void> {
    if (!this.app.domain) return;

    const servePath = `${this.config.remotePath}/current`;

    const appName = this.config.remotePath.split('/').pop() ?? 'app';
    const caddyConfig = this.generateFrontendCaddyfile(appName, servePath);

    const escaped = caddyConfig.replace(/'/g, "'\"'\"'");
    await this.executor.execOrThrow(`echo '${escaped}' > /etc/caddy/conf.d/${appName}.caddy`);
    await this.executor.execOrThrow('systemctl reload caddy');
  }

  private generateBackendCaddyfile(appName: string, port: number): string {
    return `${this.app.domain} {
    reverse_proxy localhost:${port}

    encode gzip

    log {
        output file /var/log/caddy/${appName}.log
    }
}`;
  }

  private generateFrontendCaddyfile(appName: string, servePath: string): string {
    return `${this.app.domain} {
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

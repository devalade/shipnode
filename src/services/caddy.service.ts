import type { ShipnodeConfig, ShipnodeApp } from '../shared/types.js';
import type { RemoteExecutor } from '../domain/remote/executor.js';
import { getWebApp } from '../domain/pm2/apps.js';

export class CaddyService {
  constructor(
    private executor: RemoteExecutor,
    private config: ShipnodeConfig,
  ) {}

  async configureAll(): Promise<void> {
    for (const app of this.config.apps) {
      if (!app.domain) continue;

      if (app.appType === 'backend') {
        await this.configureBackend(app);
      } else {
        await this.configureFrontend(app);
      }
    }
  }

  async configureBackend(app: ShipnodeApp): Promise<void> {
    if (!app.domain || !app.pm2) return;

    const webApp = getWebApp({ ...this.config, apps: [app] } as ShipnodeConfig);
    if (!webApp) return;
    const caddyConfig = this.generateBackendCaddyfile(app, webApp.port!);

    const escaped = caddyConfig.replace(/'/g, "'\"'\"'");
    await this.executor.execOrThrow(
      `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
      `echo '${escaped}' | $SUDO tee /etc/caddy/conf.d/${app.name}.caddy > /dev/null`,
    );
  }

  async configureFrontend(app: ShipnodeApp): Promise<void> {
    if (!app.domain) return;

    const servePath = `${this.config.remotePath}/${app.name}/current`;
    const caddyConfig = this.generateFrontendCaddyfile(app, servePath);

    const escaped = caddyConfig.replace(/'/g, "'\"'\"'");
    await this.executor.execOrThrow(
      `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
      `echo '${escaped}' | $SUDO tee /etc/caddy/conf.d/${app.name}.caddy > /dev/null`,
    );
  }

  async reload(): Promise<void> {
    await this.executor.execOrThrow(
      `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; $SUDO systemctl reload caddy`,
    );
  }

  private generateBackendCaddyfile(app: ShipnodeApp, port: number): string {
    const append = this.renderAppend(app);
    return `${app.domain} {
    reverse_proxy localhost:${port}

    encode gzip

    log {
        output file /var/log/caddy/${app.name}.log
    }
${append}}`;
  }

  private generateFrontendCaddyfile(app: ShipnodeApp, servePath: string): string {
    const append = this.renderAppend(app);
    return `${app.domain} {
    root * ${servePath}
    file_server

    try_files {path} /index.html

    encode gzip

    log {
        output file /var/log/caddy/${app.name}.log
    }
${append}}`;
  }

  private renderAppend(app: ShipnodeApp): string {
    const append = app.caddy?.append?.trim();
    return append ? `\n\n    ${append.replace(/\n/g, '\n    ')}\n` : '';
  }
}

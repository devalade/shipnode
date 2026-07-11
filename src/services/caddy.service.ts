import type { ShipnodeConfig, ShipnodeApp } from '../shared/types.js';
import type { RemoteExecutor } from '../domain/remote/executor.js';
import { getWebApp } from '../domain/pm2/apps.js';

export function renderCaddyAppend(app: ShipnodeApp): string {
  const append = app.caddy?.append?.trim();
  return append ? `\n\n    ${append.replace(/\n/g, '\n    ')}\n` : '';
}

export function generateBackendCaddyfile(app: ShipnodeApp, port: number): string {
  const append = renderCaddyAppend(app);
  return `${app.domain} {
    reverse_proxy localhost:${port}

    encode gzip

    log {
        output file /var/log/caddy/${app.name}.log
    }
${append}}`;
}

export function generateFrontendCaddyfile(app: ShipnodeApp, servePath: string): string {
  const append = renderCaddyAppend(app);
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

export class CaddyService {
  constructor(
    private executor: RemoteExecutor,
    private config: ShipnodeConfig,
  ) {}

  async configureAll(): Promise<void> {
    for (const app of this.config.apps) {
      if (!app.domain) continue;

      if (app.appType === 'backend') {
        // zeroDowntime backends have their upstream flipped by the orchestrator
        // (per-colour port, after the health check) — writing the static port
        // here would point Caddy at the wrong colour.
        if (app.zeroDowntime) continue;
        await this.configureBackend(app);
      } else {
        await this.configureFrontend(app);
      }
    }
  }

  /**
   * Write the Caddy site for a backend. `portOverride` lets blue-green point the
   * upstream at the target colour's port; otherwise the web app's configured
   * port is used. Callers reload Caddy separately (`reload()`) to apply.
   */
  async configureBackend(app: ShipnodeApp, portOverride?: number): Promise<void> {
    if (!app.domain || !app.pm2) return;

    const webApp = getWebApp({ ...this.config, apps: [app] } as ShipnodeConfig);
    if (!webApp) return;
    const caddyConfig = generateBackendCaddyfile(app, portOverride ?? webApp.port!);

    const escaped = caddyConfig.replace(/'/g, "'\"'\"'");
    await this.executor.execOrThrow(
      `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
      `echo '${escaped}' | $SUDO tee /etc/caddy/conf.d/${app.name}.caddy > /dev/null`,
    );
  }

  async configureFrontend(app: ShipnodeApp): Promise<void> {
    if (!app.domain) return;

    const servePath = `${this.config.remotePath}/${app.name}/current`;
    const caddyConfig = generateFrontendCaddyfile(app, servePath);

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

}

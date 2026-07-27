import type { ShipnodeConfig, ShipnodeApp } from '../shared/types.js';
import type { RemoteExecutor } from '../domain/remote/executor.js';
import { getWebApp } from '../domain/pm2/apps.js';
import { appStateDir } from '../domain/deploy/drain.js';

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

/**
 * The site a fleet replica serves.
 *
 * A replica must not claim the app's public domain: every replica would then
 * race the others for a Let's Encrypt certificate on the same name. TLS
 * terminates at the load balancer instead, and the replica serves plain HTTP on
 * its private address.
 *
 * The readiness endpoint is what the load balancer polls. It answers 503 while
 * the drain sentinel exists and 200 otherwise, which is the whole of shipnode's
 * LB integration — matching on the file means no reload is needed to flip it.
 */
export function generateFleetCaddyfile(
  app: ShipnodeApp,
  options: {
    /** Port the load balancer connects to. */
    listen: number;
    /** Address to bind, normally the server's private IP. Omit to bind every interface. */
    bind?: string;
    /** Where traffic goes locally — the blue-green colour's port for a backend. */
    upstream?: number;
    /** Static root, for a frontend replica. */
    servePath?: string;
    readyPath: string;
    /** Directory the drain sentinel lives in. */
    stateDir: string;
  },
): string {
  const address = `http://${options.bind ?? ''}:${options.listen}`;
  const append = renderCaddyAppend(app);

  const body = options.servePath
    ? `        root * ${options.servePath}
        file_server

        try_files {path} /index.html`
    : `        reverse_proxy localhost:${options.upstream}`;

  return `${address} {
    handle ${options.readyPath} {
        @draining file {
            root ${options.stateDir}
            try_files drain
        }
        respond @draining "draining" 503
        respond "ready" 200
    }

    handle {
${body}
    }

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
      // A fleet replica serves a private port and never claims the public
      // domain, so it is configured even without one.
      if (!app.domain && !app.fleet) continue;

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

  /** Where the drain sentinel for an app lives on this host. */
  private stateDir(app: ShipnodeApp): string {
    return appStateDir(this.config.remotePath, app.name);
  }

  private async writeSite(app: ShipnodeApp, contents: string): Promise<void> {
    const escaped = contents.replace(/'/g, "'\"'\"'");
    await this.executor.execOrThrow(
      `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
      `echo '${escaped}' | $SUDO tee /etc/caddy/conf.d/${app.name}.caddy > /dev/null`,
    );
  }

  /**
   * Write the Caddy site for a backend. `portOverride` lets blue-green point the
   * upstream at the target colour's port; otherwise the web app's configured
   * port is used. Callers reload Caddy separately (`reload()`) to apply.
   */
  async configureBackend(app: ShipnodeApp, portOverride?: number): Promise<void> {
    if (!app.pm2) return;

    const webApp = getWebApp({ ...this.config, apps: [app] } as ShipnodeConfig);
    if (!webApp) return;
    const upstream = portOverride ?? webApp.port!;

    if (app.fleet) {
      await this.writeSite(app, generateFleetCaddyfile(app, {
        listen: app.fleet.port,
        bind: this.config.ssh.privateHost,
        upstream,
        readyPath: app.fleet.readyPath,
        stateDir: this.stateDir(app),
      }));
      return;
    }

    if (!app.domain) return;
    await this.writeSite(app, generateBackendCaddyfile(app, upstream));
  }

  async configureFrontend(app: ShipnodeApp): Promise<void> {
    const servePath = `${this.config.remotePath}/${app.name}/current`;

    if (app.fleet) {
      await this.writeSite(app, generateFleetCaddyfile(app, {
        listen: app.fleet.port,
        bind: this.config.ssh.privateHost,
        servePath,
        readyPath: app.fleet.readyPath,
        stateDir: this.stateDir(app),
      }));
      return;
    }

    if (!app.domain) return;
    await this.writeSite(app, generateFrontendCaddyfile(app, servePath));
  }

  async reload(): Promise<void> {
    await this.executor.execOrThrow(
      `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; $SUDO systemctl reload caddy`,
    );
  }

}

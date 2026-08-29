import type { ShipnodeConfig, ShipnodeApp } from '../shared/types.js';
import type { RemoteExecutor } from '../domain/remote/executor.js';
import { getWebApp } from '../domain/pm2/apps.js';
import { FLEET_PORT, isFleet } from '../domain/servers.js';

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
 * every interface — the load balancer's health check dials the replica directly
 * and sends its own address as the Host, which a host-bound site would not
 * match on a NAT'd cloud box.
 *
 * The block also answers the app's domain, because forwarded client traffic
 * carries whatever Host the client asked for. On a single-app replica the
 * hostless address alone would do; listing the domain keeps the host matcher
 * explicit for servers that serve more than one app.
 *
 * `http://` on the domain is load-bearing: without the scheme Caddy would try
 * to provision a certificate for it, which is the ACME race this design exists
 * to avoid.
 */
export function generateFleetCaddyfile(
  app: ShipnodeApp,
  options: {
    /** Port the load balancer connects to. */
    listen: number;
    /** Where traffic goes locally — the blue-green colour's port for a backend. */
    upstream?: number;
    /** Static root, for a frontend replica. */
    servePath?: string;
  },
): string {
  const addresses = [`http://:${options.listen}`];
  if (app.domain) addresses.push(`http://${app.domain}:${options.listen}`);
  const address = addresses.join(', ');
  const append = renderCaddyAppend(app);

  const body = options.servePath
    ? `        root * ${options.servePath}
        file_server

        try_files {path} /index.html`
    : `        reverse_proxy localhost:${options.upstream}`;

  return `${address} {
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
    let wrote = false;

    for (const app of this.config.apps) {
      // A fleet replica serves a plain port and never claims the public
      // domain, so it is configured even without one.
      if (!app.domain && !isFleet(this.config, app)) continue;

      if (app.appType === 'backend') {
        // zeroDowntime backends have their upstream flipped by the orchestrator
        // (per-colour port, after the health check) — writing the static port
        // here would point Caddy at the wrong colour.
        if (app.zeroDowntime) continue;
        await this.configureBackend(app);
      } else {
        await this.configureFrontend(app);
      }
      wrote = true;
    }

    // Writing the site file changes nothing until Caddy re-reads it. Only the
    // blue-green path reloaded, and it reloads for its own colour flip — so a
    // frontend and a recreate backend wrote a site that never took effect.
    // Once at the end rather than per app: one reload covers every site written.
    if (wrote) await this.reload();
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

    if (isFleet(this.config, app)) {
      await this.writeSite(app, generateFleetCaddyfile(app, {
        listen: FLEET_PORT,
        upstream,
      }));
      return;
    }

    if (!app.domain) return;
    await this.writeSite(app, generateBackendCaddyfile(app, upstream));
  }

  async configureFrontend(app: ShipnodeApp): Promise<void> {
    const servePath = `${this.config.remotePath}/${app.name}/current`;

    if (isFleet(this.config, app)) {
      await this.writeSite(app, generateFleetCaddyfile(app, {
        listen: FLEET_PORT,
        servePath,
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

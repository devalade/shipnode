import { randomBytes } from 'node:crypto';
import type { ShipnodeConfig } from '../shared/types.js';
import type { RemoteExecutor } from '../domain/remote/executor.js';
import { CloudflareApi, type CfTunnel } from '../infrastructure/cloudflare/api.js';
import { Tunnel } from '../domain/cloudflare/tunnel.js';

const CFD_INGRESS_TARGET = '.cfargotunnel.com';

export class CloudflareOrchestrator {
  private api: CloudflareApi;

  constructor(
    private executor: RemoteExecutor,
    private config: ShipnodeConfig,
    apiToken: string,
  ) {
    this.api = new CloudflareApi(apiToken);
  }

  async init(): Promise<void> {
    const cf = this.config.cloudflare;
    if (!cf) throw new Error('No cloudflare config found.');

    await this.ensureCloudflaredInstalled();

    const accountId = await this.api.getAccountId();
    const zoneId = await this.api.getZoneId(cf.zone);
    const tunnelName = cf.tunnelName ?? `shipnode-${this.config.ssh.host.replace(/\./g, '-')}`;

    // Prefer the tunnel already running on this host. Creating a new tunnel (or
    // picking a same-named API tunnel) while leaving the old credentials path
    // in config.yml produces a silent id/creds mismatch and takes every app
    // offline. Only mint a new tunnel when the host has no usable config.
    const hostTunnel = await this.readHostTunnel();
    let tunnelId: string;
    let tunnel: Tunnel;

    if (hostTunnel?.id && hostTunnel.credentialsPath) {
      const credsOk = await this.executor.exec(
        `test -f "${hostTunnel.credentialsPath}" && echo YES || echo NO`,
      );
      if (credsOk.stdout.trim() !== 'YES') {
        throw new Error(
          `Host config references tunnel ${hostTunnel.id} but credentials ` +
          `${hostTunnel.credentialsPath} are missing. Restore the credentials ` +
          `file or delete /etc/cloudflared/config.yml and re-run init.`,
        );
      }
      tunnelId = hostTunnel.id;
      tunnel = hostTunnel;
      tunnel.name = tunnelName;
    } else {
      const existing = await this.api.findTunnel(accountId, tunnelName);
      if (existing) {
        tunnelId = existing.id;
        const credsExists = await this.executor.exec(
          `test -f "/etc/cloudflared/${tunnelId}.json" && echo YES || echo NO`,
        );
        if (credsExists.stdout.trim() !== 'YES') {
          throw new Error(
            `Tunnel "${tunnelName}" already exists (id ${tunnelId}) but its credentials file is not on this host. ` +
            `Delete the tunnel in the Cloudflare dashboard (or via API) and re-run \`shipnode cloudflare init\`, ` +
            `or copy /etc/cloudflared/${tunnelId}.json from the host that owns it.`,
          );
        }
      } else {
        const secret = randomBytes(32).toString('base64');
        const created: CfTunnel = await this.api.createTunnel(accountId, tunnelName, secret);
        tunnelId = created.id;
        await this.writeCredentials(tunnelId, tunnelName, accountId, secret);
      }
      tunnel = new Tunnel(tunnelName, tunnelId, `/etc/cloudflared/${tunnelId}.json`);
    }

    for (const app of this.config.apps) {
      const webApp = app.pm2?.apps.find((a) => a.port !== undefined);
      if (app.domain && webApp) {
        this.addAppIngress(tunnel, app.domain, webApp.port!, Boolean(app.zeroDowntime));
        await this.api.upsertDnsRecord(zoneId, {
          type: 'CNAME',
          name: app.domain,
          content: `${tunnelId}${CFD_INGRESS_TARGET}`,
          proxied: true,
        });
      }
    }

    if (cf.sshHostname) {
      tunnel.addIngress(cf.sshHostname, 'ssh://localhost:22');
      await this.api.upsertDnsRecord(zoneId, {
        type: 'CNAME',
        name: cf.sshHostname,
        content: `${tunnelId}${CFD_INGRESS_TARGET}`,
        proxied: true,
      });
    }

    // Credentials path must always match the tunnel id we advertise in DNS.
    tunnel.id = tunnelId;
    tunnel.credentialsPath = `/etc/cloudflared/${tunnelId}.json`;

    await this.writeConfig(tunnel);
    await this.installAndStartService();

    if (cf.lockdownFirewall) {
      await this.lockdownFirewall();
    }

    if (cf.accessEmails?.length) {
      await this.api.verifyToken();
    }
  }

  async audit(): Promise<{ zone: { name: string; id: string; status: string }; apps: { domain: string; port: number | undefined }[]; tunnelList: string; service: string }> {
    const cf = this.config.cloudflare;
    if (!cf) throw new Error('No cloudflare config found.');

    const zoneId = await this.api.getZoneId(cf.zone);
    const zoneInfo = await this.api.fetch<{ id: string; name: string; status: string }>(`/zones/${zoneId}`);

    const apps = this.config.apps
      .map((a) => {
        const web = a.pm2?.apps.find((p) => p.port !== undefined);
        return web && a.domain ? { domain: a.domain, port: web.port } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const tunnelResult = await this.executor.exec('cloudflared tunnel list 2>/dev/null || echo MISSING');
    const tunnelList = tunnelResult.stdout.includes('MISSING') ? 'not installed' : tunnelResult.stdout.trim();

    const svcResult = await this.executor.exec('systemctl is-active cloudflared 2>/dev/null || echo inactive');

    return {
      zone: { name: zoneInfo.name, id: zoneInfo.id, status: zoneInfo.status },
      apps,
      tunnelList,
      service: svcResult.stdout.trim(),
    };
  }

  async status(): Promise<string> {
    const result = await this.executor.exec(
      `systemctl status cloudflared 2>&1; echo "---"; cat /etc/cloudflared/config.yml 2>&1 || true`,
    );
    return result.stdout;
  }

  /**
   * Install cloudflared from Cloudflare's apt repo, falling back to the
   * upstream .deb from GitHub when the repo has no package for this codename
   * (fresh Ubuntu releases like 26.04/resolute lag behind pkg.cloudflare.com).
   */
  private async ensureCloudflaredInstalled(): Promise<void> {
    const check = await this.executor.exec('command -v cloudflared 2>/dev/null || echo MISSING');
    if (check.stdout.trim() !== 'MISSING') return;

    const repoResult = await this.executor.exec(
      `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
      `curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | $SUDO tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null && ` +
      `echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | ` +
      `$SUDO tee /etc/apt/sources.list.d/cloudflared.list > /dev/null && ` +
      `$SUDO apt-get update -qq 2>&1 && $SUDO apt-get install -y -qq cloudflared`,
    );
    if (repoResult.exitCode === 0) return;

    // apt failed (usually because the codename isn't published yet). Remove the
    // stale sources entry so future `apt update` doesn't keep erroring, then
    // fall back to the upstream .deb.
    await this.executor.exec(
      `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; $SUDO rm -f /etc/apt/sources.list.d/cloudflared.list && $SUDO apt-get update -qq >/dev/null 2>&1 || true`,
    );
    await this.executor.execOrThrow(
      `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
      `ARCH=$(dpkg --print-architecture) && ` +
      `TMP=$(mktemp --suffix=.deb) && ` +
      `curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH.deb" -o "$TMP" && ` +
      `$SUDO dpkg -i "$TMP" && rm -f "$TMP"`,
    );
  }

  /**
   * Write the credentials JSON cloudflared expects when tunnel_secret was
   * supplied at creation time. Format is stable and undocumented but widely
   * used; see https://github.com/cloudflare/cloudflared/blob/master/tunnel/token.go
   */
  private async writeCredentials(
    tunnelId: string,
    tunnelName: string,
    accountId: string,
    secretBase64: string,
  ): Promise<void> {
    const payload = JSON.stringify({
      AccountTag: accountId,
      TunnelSecret: secretBase64,
      TunnelID: tunnelId,
      TunnelName: tunnelName,
    });
    const b64 = Buffer.from(payload).toString('base64');
    await this.executor.execOrThrow(
      `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
      `$SUDO mkdir -p /etc/cloudflared && ` +
      `printf '%s' '${b64}' | base64 -d | $SUDO tee "/etc/cloudflared/${tunnelId}.json" > /dev/null && ` +
      `$SUDO chmod 600 "/etc/cloudflared/${tunnelId}.json"`,
    );
  }

  /**
   * Blue-green apps flip Caddy's upstream between colours. Pointing the tunnel
   * at a fixed app port would pin traffic to one colour and break rollouts.
   * Route those hostnames through local Caddy (TLS) with the public Host header.
   */
  private addAppIngress(
    tunnel: Tunnel,
    domain: string,
    port: number,
    zeroDowntime: boolean,
  ): void {
    if (zeroDowntime) {
      tunnel.addIngress(domain, 'https://localhost:443', {
        noTLSVerify: true,
        originServerName: domain,
        httpHostHeader: domain,
      });
      return;
    }
    tunnel.addIngress(domain, `http://localhost:${port}`);
  }

  private async readHostTunnel(): Promise<Tunnel | null> {
    const existing = await this.executor.exec(
      `cat /etc/cloudflared/config.yml 2>/dev/null || echo ""`,
    );
    const yaml = existing.stdout.trim();
    if (!yaml) return null;
    return Tunnel.fromYaml(yaml);
  }

  private async writeConfig(tunnel: Tunnel): Promise<void> {
    const yaml = tunnel.toYaml();
    const b64 = Buffer.from(yaml).toString('base64');
    await this.executor.execOrThrow(
      `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
      `$SUDO mkdir -p /etc/cloudflared && ` +
      `$SUDO cp /etc/cloudflared/config.yml "/etc/cloudflared/config.yml.bak.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true; ` +
      `printf '%s' '${b64}' | base64 -d | $SUDO tee /etc/cloudflared/config.yml > /dev/null`,
    );
  }

  /**
   * `cloudflared service install` writes the systemd unit that reads
   * /etc/cloudflared/config.yml. Idempotent: re-installing an existing unit
   * updates it; a running service is restarted to pick up config changes.
   */
  private async installAndStartService(): Promise<void> {
    await this.executor.exec(
      `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
      `$SUDO cloudflared service install 2>/dev/null || true`,
    );
    await this.executor.execOrThrow(
      `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
      `$SUDO systemctl enable cloudflared 2>/dev/null; ` +
      // Type=notify + fresh QUIC handshake can exceed the default 15s start
      // timeout on a busy host; bump before restart so init doesn't false-fail.
      `$SUDO mkdir -p /etc/systemd/system/cloudflared.service.d && ` +
      `printf '%s\n' '[Service]' 'TimeoutStartSec=60' | $SUDO tee /etc/systemd/system/cloudflared.service.d/timeout.conf > /dev/null && ` +
      `$SUDO systemctl daemon-reload && ` +
      `$SUDO systemctl restart cloudflared`,
    );
  }

  private async lockdownFirewall(): Promise<void> {
    const webPorts = this.config.apps
      .flatMap((a) => a.pm2?.apps ?? [])
      .filter((a) => a.port !== undefined)
      .map((a) => a.port!);

    if (!webPorts.length) return;

    const cfIps = await this.api.getCloudflareIps();
    for (const port of webPorts) {
      for (const cidr of cfIps.ipv4_cidrs ?? []) {
        await this.executor.exec(
          `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
          `$SUDO ufw allow from ${cidr} to any port ${port} 2>/dev/null || true`,
        );
      }
      await this.executor.exec(
        `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
        `$SUDO ufw deny ${port} 2>/dev/null || true`,
      );
    }
  }
}

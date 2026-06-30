import type { ShipnodeConfig } from '../shared/types.js';
import type { RemoteExecutor } from '../domain/remote/executor.js';
import { CloudflareApi } from '../infrastructure/cloudflare/api.js';
import { Tunnel } from '../domain/cloudflare/tunnel.js';

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
    const tunnelName = cf.tunnelName ?? `shipnode-${this.config.ssh.host.replace(/\./g, '-')}`;

    await this.executor.exec(`cloudflared tunnel create "${tunnelName}" 2>&1`);
    const tunnelId = await this.resolveTunnelId();

    const tunnel = new Tunnel(tunnelName, tunnelId, `/root/.cloudflared/${tunnelId}.json`);

    for (const app of this.config.apps) {
      const webApp = app.pm2?.apps.find((a) => a.port !== undefined);
      if (app.domain && webApp) {
        tunnel.addIngress(app.domain, `http://localhost:${webApp.port}`);
        await this.executor.exec(`cloudflared tunnel route dns "${tunnelName}" "${app.domain}"`);
      }
    }

    if (cf.sshHostname) {
      tunnel.addIngress(cf.sshHostname, 'ssh://localhost:22');
      await this.executor.exec(`cloudflared tunnel route dns "${tunnelName}" "${cf.sshHostname}"`);
    }

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
      `systemctl status cloudflared 2>&1; echo "---"; cloudflared tunnel info 2>&1 || true`,
    );
    return result.stdout;
  }

  private async ensureCloudflaredInstalled(): Promise<void> {
    const check = await this.executor.exec('command -v cloudflared 2>/dev/null || echo MISSING');
    if (check.stdout.trim() !== 'MISSING') return;

    await this.executor.exec(
      `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
      `curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | $SUDO tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null && ` +
      `echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | ` +
      `$SUDO tee /etc/apt/sources.list.d/cloudflared.list && ` +
      `$SUDO apt-get update -qq && $SUDO apt-get install -y -qq cloudflared`,
    );
  }

  private async resolveTunnelId(): Promise<string> {
    const result = await this.executor.exec(
      `cloudflared tunnel list --output json 2>/dev/null | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4`,
    );
    const tunnelId = result.stdout.trim();
    if (!tunnelId) throw new Error('Could not determine tunnel ID. Check: cloudflared tunnel list');
    return tunnelId;
  }

  private async writeConfig(tunnel: Tunnel): Promise<void> {
    const yaml = tunnel.toYaml();
    const b64 = Buffer.from(yaml).toString('base64');
    await this.executor.exec(
      `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
      `mkdir -p /etc/cloudflared && ` +
      `printf '%s' '${b64}' | base64 -d | $SUDO tee /etc/cloudflared/config.yml > /dev/null`,
    );
  }

  private async installAndStartService(): Promise<void> {
    await this.executor.exec(
      `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
      `$SUDO cloudflared service install && $SUDO systemctl start cloudflared`,
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

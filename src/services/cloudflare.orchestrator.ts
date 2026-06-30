import type { ShipnodeConfig } from '../shared/types.js';
import type { RemoteExecutor } from '../domain/remote/executor.js';
import { CloudflareApi } from '../infrastructure/cloudflare/api.js';
import { getWebApp } from '../domain/pm2/apps.js';

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

    if (cf.appHostname) {
      await this.executor.exec(`cloudflared tunnel route dns "${tunnelName}" "${cf.appHostname}"`);
    }

    if (cf.sshHostname) {
      await this.executor.exec(`cloudflared tunnel route dns "${tunnelName}" "${cf.sshHostname}"`);
    }

    await this.writeTunnelConfig(tunnelId, cf);
    await this.installAndStartService();

    if (cf.lockdownFirewall) {
      await this.lockdownFirewall();
    }

    if (cf.accessEmails?.length) {
      await this.api.verifyToken();
    }
  }

  async audit(): Promise<{ zone: { name: string; id: string; status: string }; dns: string; tunnelList: string; service: string }> {
    const cf = this.config.cloudflare;
    if (!cf) throw new Error('No cloudflare config found.');

    const zoneId = await this.api.getZoneId(cf.zone);
    const zoneInfo = await this.api.fetch<{ id: string; name: string; status: string }>(`/zones/${zoneId}`);

    let dns = '';
    if (cf.appHostname) {
      const records = await this.api.getDnsRecords(zoneId, cf.appHostname);
      dns = records.length ? `${records[0].type} → ${records[0].content}` : 'NOT FOUND';
    }

    const tunnelResult = await this.executor.exec('cloudflared tunnel list 2>/dev/null || echo MISSING');
    const tunnelList = tunnelResult.stdout.includes('MISSING') ? 'not installed' : tunnelResult.stdout.trim();

    const svcResult = await this.executor.exec('systemctl is-active cloudflared 2>/dev/null || echo inactive');

    return {
      zone: { name: zoneInfo.name, id: zoneInfo.id, status: zoneInfo.status },
      dns,
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

  private async writeTunnelConfig(tunnelId: string, cf: NonNullable<ShipnodeConfig['cloudflare']>): Promise<void> {
    const webApp = getWebApp(this.config);
    if (cf.appHostname && !webApp) {
      throw new Error('cloudflare.appHostname is set but no pm2.apps entry declares a port — nothing to route HTTP to.');
    }
    const appIngress = cf.appHostname && webApp
      ? `  - hostname: ${cf.appHostname}\n    service: http://localhost:${webApp.port}`
      : '';
    const sshIngress = cf.sshHostname
      ? `  - hostname: ${cf.sshHostname}\n    service: ssh://localhost:22`
      : '';

    const cfConfig = `tunnel: ${tunnelId}
credentials-file: /root/.cloudflared/${tunnelId}.json

ingress:
${appIngress}
${sshIngress}
  - service: http_status:404
`;

    const b64 = Buffer.from(cfConfig).toString('base64');
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
    const webApp = getWebApp(this.config);
    if (!webApp) return;

    const cfIps = await this.api.getCloudflareIps();
    for (const cidr of cfIps.ipv4_cidrs ?? []) {
      await this.executor.exec(
        `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
        `$SUDO ufw allow from ${cidr} to any port ${webApp.port} 2>/dev/null || true`,
      );
    }
    await this.executor.exec(
      `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
      `$SUDO ufw deny ${webApp.port} 2>/dev/null || true`,
    );
  }
}

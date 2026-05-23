import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';
import { getWebApp } from '../../domain/pm2/apps.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

interface CfApiOptions {
  apiToken: string;
}

async function cfFetch(path: string, opts: CfApiOptions, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${opts.apiToken}`,
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> ?? {}),
    },
  });
  const json = await res.json() as { success: boolean; errors?: { message: string }[]; result: unknown };
  if (!json.success) {
    const msg = json.errors?.map((e) => e.message).join(', ') ?? 'Unknown error';
    throw new Error(`Cloudflare API error: ${msg}`);
  }
  return json.result;
}

function requireToken(): string {
  const token = process.env['CLOUDFLARE_API_TOKEN'] ?? process.env['CF_API_TOKEN'];
  if (!token) {
    ui.error('CLOUDFLARE_API_TOKEN env var required');
    process.exit(1);
  }
  return token;
}

export async function cmdCloudflareInit(
  cwd: string,
  options: { config?: string },
): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      if (!config.cloudflare) {
        ui.error('No cloudflare config found. Add a cloudflare block to shipnode.config.ts');
        process.exit(1);
      }

      const cf = config.cloudflare;
      const apiToken = requireToken();

      ui.info('Installing cloudflared...');

      const installCheck = await executor.exec('command -v cloudflared 2>/dev/null || echo MISSING');
      if (installCheck.stdout.trim() === 'MISSING') {
        await executor.exec(
          `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
          `curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | $SUDO tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null && ` +
          `echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | ` +
          `$SUDO tee /etc/apt/sources.list.d/cloudflared.list && ` +
          `$SUDO apt-get update -qq && $SUDO apt-get install -y -qq cloudflared`,
        );
        ui.success('cloudflared installed');
      } else {
        ui.info('cloudflared already installed');
      }

      const tunnelName = cf.tunnelName ?? `shipnode-${config.ssh.host.replace(/\./g, '-')}`;
      ui.info(`Creating tunnel: ${tunnelName}`);

      // Create tunnel via API to get ID, then install on server
      const cfApiOpts: CfApiOptions = { apiToken };

      // Get zone ID
      const zones = await cfFetch(`/zones?name=${cf.zone}`, cfApiOpts) as { id: string }[];
      if (!zones.length) throw new Error(`Zone "${cf.zone}" not found`);
      const zoneId = zones[0].id;

      // Create tunnel (remote execution: cloudflared tunnel create)
      const createResult = await executor.exec(
        `cloudflared tunnel create "${tunnelName}" 2>&1`,
      );
      ui.info(createResult.stdout.trim());

      // Get tunnel UUID from list
      const listResult = await executor.exec(
        `cloudflared tunnel list --output json 2>/dev/null | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4`,
      );
      const tunnelId = listResult.stdout.trim();

      if (!tunnelId) {
        ui.error('Could not determine tunnel ID. Check: cloudflared tunnel list');
        process.exit(1);
      }

      // Create DNS records if appHostname set
      if (cf.appHostname) {
        await executor.exec(
          `cloudflared tunnel route dns "${tunnelName}" "${cf.appHostname}"`,
        );
        ui.success(`DNS: ${cf.appHostname} → tunnel`);
      }

      if (cf.sshHostname) {
        await executor.exec(
          `cloudflared tunnel route dns "${tunnelName}" "${cf.sshHostname}"`,
        );
        ui.success(`DNS: ${cf.sshHostname} → tunnel`);
      }

      // Generate config and start as systemd service
      const webApp = getWebApp(config);
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
      await executor.exec(
        `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
        `mkdir -p /etc/cloudflared && ` +
        `printf '%s' '${b64}' | base64 -d | $SUDO tee /etc/cloudflared/config.yml > /dev/null`,
      );

      await executor.exec(
        `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
        `$SUDO cloudflared service install && $SUDO systemctl start cloudflared`,
      );

      // Setup firewall lockdown if requested
      if (cf.lockdownFirewall) {
        if (!webApp) {
          ui.warn('Skipping firewall lockdown: no web app (no pm2.apps entry with a port) to expose.');
        } else {
          ui.info('Locking down firewall to Cloudflare IPs only...');
          const cfIpv4 = await cfFetch('/ips', cfApiOpts) as { ipv4_cidrs: string[] };
          for (const cidr of cfIpv4.ipv4_cidrs ?? []) {
            await executor.exec(
              `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
              `$SUDO ufw allow from ${cidr} to any port ${webApp.port} 2>/dev/null || true`,
            );
          }
          await executor.exec(
            `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
            `$SUDO ufw deny ${webApp.port} 2>/dev/null || true`,
          );
          ui.success('Firewall locked to Cloudflare IPs');
        }
      }

      // Setup Access policy if accessEmails present
      if (cf.accessEmails?.length && zoneId) {
        ui.info('Setting up Cloudflare Access policy...');
        await cfFetch(`/accounts`, cfApiOpts); // just to verify token works
        ui.info(`Access policy: configure manually at dash.cloudflare.com for zone ${cf.zone}`);
        ui.info(`Allowed emails: ${cf.accessEmails.join(', ')}`);
      }

      ui.success(`Cloudflare tunnel "${tunnelName}" initialized.`);
    },
    { configPath: options.config },
  );
}

export async function cmdCloudflareAudit(
  cwd: string,
  options: { config?: string },
): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      if (!config.cloudflare) {
        ui.error('No cloudflare config found.');
        process.exit(1);
      }

      const apiToken = requireToken();
      const cf = config.cloudflare;
      const cfApiOpts: CfApiOptions = { apiToken };

      ui.info(`Auditing Cloudflare config for zone: ${cf.zone}`);

      const zones = await cfFetch(`/zones?name=${cf.zone}`, cfApiOpts) as { id: string; name: string; status: string }[];
      if (!zones.length) {
        ui.error(`Zone "${cf.zone}" not found in account`);
        return;
      }

      const zone = zones[0];
      console.log(`  Zone: ${zone.name} (${zone.id}) — ${zone.status}`);

      // Check DNS records
      if (cf.appHostname) {
        const records = await cfFetch(
          `/zones/${zone.id}/dns_records?name=${cf.appHostname}`,
          cfApiOpts,
        ) as { type: string; content: string }[];
        if (records.length) {
          console.log(`  DNS ${cf.appHostname}: ${records[0].type} → ${records[0].content}`);
        } else {
          ui.warn(`  DNS ${cf.appHostname}: NOT FOUND`);
        }
      }

      // Check tunnel on server
      const tunnelCheck = await executor.exec('cloudflared tunnel list 2>/dev/null || echo MISSING');
      if (tunnelCheck.stdout.includes('MISSING')) {
        ui.warn('  cloudflared: not installed');
      } else {
        console.log(`  cloudflared tunnels:\n${tunnelCheck.stdout.trim()}`);
      }

      // Check service
      const svcCheck = await executor.exec('systemctl is-active cloudflared 2>/dev/null || echo inactive');
      console.log(`  cloudflared service: ${svcCheck.stdout.trim()}`);
    },
    { configPath: options.config },
  );
}

export async function cmdCloudflareStatus(
  cwd: string,
  options: { config?: string },
): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ executor }) => {
      const result = await executor.exec(
        `systemctl status cloudflared 2>&1; echo "---"; cloudflared tunnel info 2>&1 || true`,
      );
      console.log(result.stdout);
    },
    { configPath: options.config },
  );
}

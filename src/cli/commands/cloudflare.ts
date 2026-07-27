import { runRemoteCommandForTargets } from '../runner.js';
import { ui } from '../ui.js';
import { CloudflareOrchestrator } from '../../services/cloudflare.orchestrator.js';
import { loadConfig } from '../../config/loader.js';
import { getServerTargets, configForServer, expandTarget } from '../../domain/servers.js';
import type { ShipnodeConfig } from '../../shared/types.js';

function requireToken(): string {
  const token = process.env['CLOUDFLARE_API_TOKEN'] ?? process.env['CF_API_TOKEN'];
  if (!token) {
    ui.error('CLOUDFLARE_API_TOKEN env var required');
    process.exit(1);
  }
  return token;
}

/** Servers that actually host an app with a domain, and so need a tunnel. */
function tunnelledServers(config: ShipnodeConfig): string[] {
  return getServerTargets(config)
    .map((target) => target.name)
    .filter((name) => configForServer(config, name).apps.some((app) => app.domain));
}

/**
 * A tunnel name identifies one host's connector, and its credentials live on
 * that host. Sharing an explicit name across servers makes the second `init`
 * fail on the missing-credentials guard, so reject it up front with a fix
 * rather than halfway through the fan-out.
 */
function assertTunnelNameIsUnambiguous(config: ShipnodeConfig): void {
  const explicit = config.cloudflare?.tunnelName;
  if (!explicit) return;

  const servers = tunnelledServers(config);
  if (servers.length <= 1) return;

  ui.error(
    `cloudflare.tunnelName is set to "${explicit}", but ${servers.length} servers host apps with domains ` +
    `(${servers.join(', ')}). A tunnel belongs to one host. Remove tunnelName to get a per-host default ` +
    `(shipnode-<host>), or run cloudflare init against one server at a time.`,
  );
  process.exit(1);
}

export async function cmdCloudflareInit(
  cwd: string,
  options: { config?: string },
): Promise<void> {
  const workspace = await loadConfig(cwd, options.config);
  assertTunnelNameIsUnambiguous(workspace);

  // Only one tunnel can own the workspace's ssh hostname: the default server,
  // or the first declared when there is no server called `default`.
  const sshHostnameOwner = expandTarget(workspace, undefined)[0]
    ?? getServerTargets(workspace)[0]?.name;

  await runRemoteCommandForTargets(
    cwd,
    async ({ config, executor, serverName }) => {
      ui.step(`Cloudflare: ${serverName} (${config.ssh.user}@${config.ssh.host})`);
      const orchestrator = new CloudflareOrchestrator(executor, config, requireToken(), {
        manageSshHostname: serverName === sshHostnameOwner,
      });
      await orchestrator.init();
      ui.success(`Cloudflare tunnel initialized on ${serverName}.`);
    },
    { configPath: options.config },
  );
}

export async function cmdCloudflareAudit(
  cwd: string,
  options: { config?: string },
): Promise<void> {
  await runRemoteCommandForTargets(
    cwd,
    async ({ config, executor, serverName }) => {
      const orchestrator = new CloudflareOrchestrator(executor, config, requireToken());
      const result = await orchestrator.audit();
      ui.heading(`Server: ${serverName} (${config.ssh.user}@${config.ssh.host})`);
      console.log(`  Zone: ${result.zone.name} (${result.zone.id}) — ${result.zone.status}`);
      for (const app of result.apps) {
        console.log(`  DNS ${app.domain} → localhost:${app.port}`);
      }
      console.log(`  cloudflared tunnels:\n${result.tunnelList}`);
      console.log(`  cloudflared service: ${result.service}`);
    },
    { configPath: options.config },
  );
}

export async function cmdCloudflareStatus(
  cwd: string,
  options: { config?: string },
): Promise<void> {
  await runRemoteCommandForTargets(
    cwd,
    async ({ config, executor, serverName }) => {
      const orchestrator = new CloudflareOrchestrator(executor, config, requireToken());
      const output = await orchestrator.status();
      ui.heading(`Server: ${serverName} (${config.ssh.user}@${config.ssh.host})`);
      console.log(output);
    },
    { configPath: options.config },
  );
}

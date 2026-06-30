import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';
import { CloudflareOrchestrator } from '../../services/cloudflare.orchestrator.js';

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
  await runRemoteCommand(cwd, async ({ config, executor }) => {
    const orchestrator = new CloudflareOrchestrator(executor, config, requireToken());
    await orchestrator.init();
    ui.success(`Cloudflare tunnel initialized.`);
  }, { configPath: options.config });
}

export async function cmdCloudflareAudit(
  cwd: string,
  options: { config?: string },
): Promise<void> {
  await runRemoteCommand(cwd, async ({ config, executor }) => {
    const orchestrator = new CloudflareOrchestrator(executor, config, requireToken());
    const result = await orchestrator.audit();
    console.log(`  Zone: ${result.zone.name} (${result.zone.id}) — ${result.zone.status}`);
    for (const app of result.apps) {
      console.log(`  DNS ${app.domain} → localhost:${app.port}`);
    }
    console.log(`  cloudflared tunnels:\n${result.tunnelList}`);
    console.log(`  cloudflared service: ${result.service}`);
  }, { configPath: options.config });
}

export async function cmdCloudflareStatus(
  cwd: string,
  options: { config?: string },
): Promise<void> {
  await runRemoteCommand(cwd, async ({ config, executor }) => {
    const orchestrator = new CloudflareOrchestrator(executor, config, requireToken());
    const output = await orchestrator.status();
    console.log(output);
  }, { configPath: options.config });
}

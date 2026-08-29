import { runRemoteCommandForConfig } from '../runner.js';
import { ReleaseManager } from '../../domain/release/manager.js';
import { HealthCheckService } from '../../services/health.service.js';
import { CaddyService } from '../../services/caddy.service.js';
import { SshConnection } from '../../infrastructure/ssh/connection.js';
import { ui } from '../ui.js';
import { confirm } from '../prompt.js';
import { loadConfig } from '../../config/loader.js';
import { getActiveApp } from '../../domain/workspace.js';
import { getDeploymentName, getEcosystemPath, getWebApp } from '../../domain/pm2/apps.js';
import {
  readDeployState,
  writeDeployState,
  otherColor,
  portFor,
  coloredWebName,
} from '../../domain/deploy/blue-green.js';
import { rollFleet, type FleetEvent } from '../../domain/deploy/fleet.js';
import { isFleet } from '../../domain/servers.js';
import type { RemoteExecutor } from '../../domain/remote/executor.js';
import type { ShipnodeConfig, ShipnodeApp } from '../../shared/types.js';
import { configForAppResult, configForServer, getServerTargets } from '../../domain/servers.js';

/**
 * Asked once, answered once.
 *
 * The single-server path prompts with the concrete release it is about to
 * restore. A fleet asks up front, before the roll starts, because prompting
 * inside the per-replica callback would ask N times — and the second prompt
 * would arrive with half the fleet already rolled back.
 */
type Confirmer = (message: string) => Promise<boolean>;

const alreadyConfirmed: Confirmer = async () => true;

export async function cmdRollback(
  cwd: string,
  options: { steps?: number; app?: string; config?: string; on?: string },
): Promise<void> {
  if (!options.app) {
    throw new Error(
      `rollback requires --app <name>. Available apps: ${(await loadConfig(cwd, options.config)).apps.map((a) => a.name).join(', ')}`,
    );
  }
  const fullConfig = await loadConfig(cwd, options.config);
  const selectedConfig = configForAppResult(fullConfig, options.app);
  if (selectedConfig.isErr()) {
    ui.error(selectedConfig.error.message);
    process.exit(1);
    return;
  }

  const appConfig = selectedConfig.value;
  const app = getActiveApp(appConfig, options.app);
  const stepsBack = options.steps ?? 1;

  if (isFleet(appConfig, app)) {
    await rollbackFleet(appConfig, app, stepsBack, options.on);
    return;
  }

  await runRemoteCommandForConfig(appConfig, async ({ config, executor }) => {
    await rollbackReplica(executor, config, app, stepsBack, confirm);
  });
}

/**
 * Roll a fleet back one replica at a time, through the same roll a deploy
 * uses — a rollback that restarts PM2 has the same traffic-dropping window a
 * deploy does.
 *
 * Each replica re-reads its own state and rolls itself back one step rather than
 * being told what to do by a plan computed elsewhere. After a roll that failed
 * halfway the fleet is deliberately not uniform, and "everyone flip to green"
 * would put the already-correct replicas back on the bad release.
 */
async function rollbackFleet(
  appConfig: ShipnodeConfig,
  app: ShipnodeApp,
  stepsBack: number,
  on: string | undefined,
): Promise<void> {
  const allReplicas = getServerTargets(appConfig).map((target) => target.name);
  let replicas = allReplicas;
  if (on) {
    if (!replicas.includes(on)) {
      ui.error(`App '${app.name}' does not run on '${on}'. It runs on: ${replicas.join(', ')}`);
      process.exit(1);
      return;
    }
    replicas = [on];
  }

  ui.warn(`Rolling ${app.name} back ${stepsBack} release(s) across ${replicas.join(', ')}, one replica at a time.`);
  if (!(await confirm('Proceed with rollback?'))) {
    ui.info('Rollback cancelled.');
    return;
  }

  const result = await rollFleet({
    replicas,
    primary: allReplicas[0],
    connect: async (serverName) => {
      const ssh = new SshConnection();
      await ssh.connect(configForServer(appConfig, serverName).ssh);
      return { executor: ssh, close: () => ssh.disconnect() };
    },
    applyToReplica: async ({ serverName, executor }) => {
      const replicaConfig = { ...configForServer(appConfig, serverName), apps: [app] };
      await rollbackReplica(executor, replicaConfig, app, stepsBack, alreadyConfirmed);
    },
    onEvent: (event) => reportRollbackEvent(app, event),
  });

  if (result.failed) {
    ui.error(
      `${app.name}: ${result.failed.server} failed to roll back. ` +
      `${result.applied.length ? `${result.applied.join(', ')} rolled back; ` : ''}` +
      `${result.skipped.length ? `${result.skipped.join(', ')} untouched. ` : ''}` +
      `The fleet is running mixed versions.`,
    );
    process.exit(1);
    return;
  }

  ui.success(`${app.name} rolled back on ${result.applied.join(', ')}`);
}

function reportRollbackEvent(app: ShipnodeApp, event: FleetEvent): void {
  switch (event.type) {
    case 'applying':
      ui.step(`Rolling back ${app.name} on ${event.server}`);
      break;
    case 'applied':
      ui.success(`${event.server} rolled back`);
      break;
    case 'failed':
      ui.error(`${event.server}: ${event.message}`);
      break;
    default:
      break;
  }
}

/** Roll one server back. `config` must already be scoped to that server. */
async function rollbackReplica(
  executor: RemoteExecutor,
  config: ShipnodeConfig,
  app: ShipnodeApp,
  stepsBack: number,
  ask: Confirmer,
): Promise<void> {
  const appPath = `${config.remotePath}/${app.name}`;

  // Blue-green apps roll back by flipping Caddy back to the previous colour,
  // which is still running — instant and zero-drop. No pm2 restart.
  if (app.appType === 'backend' && app.zeroDowntime) {
    await rollbackBlueGreen(executor, config, app, appPath, stepsBack, ask);
    return;
  }

  const releases = new ReleaseManager(executor, appPath, app.keepReleases);

  ui.info('Fetching release history...');
  const allReleases = await releases.listReleases();

  if (allReleases.length < 2) {
    throw new Error('No previous release to roll back to.');
  }

  const targetIdx = allReleases.length - 1 - stepsBack;
  if (targetIdx < 0) {
    throw new Error(
      `Cannot go back ${stepsBack} step(s) — only ${allReleases.length} release(s) recorded.`,
    );
  }

  const current = allReleases[allReleases.length - 1];
  const target = allReleases[targetIdx];

  ui.warn(`Current release: ${current.timestamp}`);
  ui.warn(`Target release:  ${target.timestamp}`);

  const ok = await ask('Proceed with rollback?');
  if (!ok) {
    ui.info('Rollback cancelled.');
    return;
  }

  const targetPath = `${appPath}/releases/${target.timestamp}`;
  await releases.switchSymlink(targetPath);
  ui.success('Symlink switched');

  const namespace = getDeploymentName(config);
  if (app.appType === 'backend' && namespace) {
    const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
    const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
    // Prefer reloading from the rolled-back release's ecosystem file (ADR-0001 — it
    // restores the exact process set that was active for that release). Fall back to
    // namespace reload if the target release predates per-release ecosystem files.
    const ecosystem = getEcosystemPath(config, app.name);
    await executor.execOrThrow(
      `${mise}; mise exec node@${nodeVersion} -- ` +
      `(pm2 reload "${ecosystem}" --update-env 2>/dev/null || pm2 reload ${namespace} --update-env)`,
    );
    ui.success('PM2 reloaded');
  }

  if (app.appType === 'backend' && app.healthCheck.enabled) {
    ui.info('Running health check...');
    const health = new HealthCheckService(executor, config);
    await health.perform(app);
    ui.success('Health check passed');
  }

  ui.success(`Rolled back to ${target.timestamp}`);
}

/**
 * Instant blue-green rollback: the previous colour is still resident, so we
 * flip Caddy's upstream back to it and swap the persisted active colour. No
 * process restart, no dropped requests.
 *
 * Only one step back is possible — older colours were reaped by later deploys.
 * For anything deeper, redeploy the desired release instead.
 */
async function rollbackBlueGreen(
  executor: RemoteExecutor,
  config: ShipnodeConfig,
  app: ShipnodeApp,
  appPath: string,
  stepsBack: number,
  ask: Confirmer,
): Promise<void> {
  if (app.blueGreenRetention === 'none') {
    throw new Error(
      'Instant blue-green rollback is disabled because blueGreenRetention is "none". ' +
      'Redeploy the desired release instead.',
    );
  }

  if (stepsBack !== 1) {
    throw new Error(
      `Blue-green rollback only supports one step (the live previous colour). ` +
      `To go further back, redeploy the desired release.`,
    );
  }

  const state = await readDeployState(executor, appPath);
  if (!state) {
    throw new Error('No blue-green state found on the server — nothing to roll back to.');
  }

  const webApp = getWebApp({ ...config, apps: [app] } as ShipnodeConfig);
  if (!webApp) {
    throw new Error('No web app (pm2 app with a port) found for this deployment.');
  }
  const namespace = app.pm2?.apps[0]?.name ?? app.name;
  const previous = otherColor(state.activeColor);
  const previousPort = portFor(previous, state);
  const previousName = coloredWebName(namespace, webApp.name, previous);

  // The previous colour must still be online to serve traffic after the flip.
  // Parse pm2's JSON in-process rather than relying on `node` being on the
  // remote PATH at rollback time.
  const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
  const jlist = await executor.exec(`${mise} && mise exec -- pm2 jlist`);
  let online = false;
  try {
    const entries = JSON.parse(jlist.stdout.trim()) as Array<{ name: string; pm2_env?: { status?: string } }>;
    online = entries.some((e) => e.name === previousName && e.pm2_env?.status === 'online');
  } catch {
    online = false;
  }
  if (!online) {
    throw new Error(
      `Previous colour "${previousName}" is not running — cannot instant-rollback. ` +
      `Redeploy the desired release instead.`,
    );
  }

  ui.warn(`Active colour:   ${state.activeColor} (port ${portFor(state.activeColor, state)})`);
  ui.warn(`Rollback target: ${previous} (port ${previousPort})`);

  const ok = await ask('Flip traffic back to the previous colour?');
  if (!ok) {
    ui.info('Rollback cancelled.');
    return;
  }

  const caddy = new CaddyService(executor, config);
  await caddy.configureBackend(app, previousPort);
  await caddy.reload();
  await writeDeployState(executor, appPath, { ...state, activeColor: previous });

  ui.success(`Rolled back — traffic now on ${previous} (port ${previousPort})`);
}

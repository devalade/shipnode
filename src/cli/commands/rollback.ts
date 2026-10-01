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
  releaseFor,
  type DeployColor,
} from '../../domain/deploy/blue-green.js';
import { reapColourCommand } from '../../domain/deploy/retention.js';
import { rollFleet, type FleetEvent } from '../../domain/deploy/fleet.js';
import { isFleet } from '../../domain/servers.js';
import type { RemoteExecutor } from '../../domain/remote/executor.js';
import type { ShipnodeConfig, ShipnodeApp, Pm2App } from '../../shared/types.js';
import { enableAndStartUnitCommand, isActiveCommand, isWatt, resolveWattUnits, restartUnitCommand, wattUnitName } from '../../domain/runtime/watt.js';
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
  options: { steps?: number; app?: string; config?: string; on?: string; yes?: boolean },
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
    await rollbackFleet(appConfig, app, stepsBack, options.on, options.yes === true);
    return;
  }

  await runRemoteCommandForConfig(appConfig, async ({ config, executor }) => {
    await rollbackReplica(executor, config, app, stepsBack, options.yes ? alreadyConfirmed : confirm);
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
  yes: boolean,
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
  if (!yes && !(await confirm('Proceed with rollback?'))) {
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
  if (app.appType === 'backend' && isWatt(app)) {
    // Launchers and configs are per-release, so restarting the units re-reads
    // the rolled-back release through the `current` symlink.
    const units = await resolveWattUnits(executor, appPath, app, { colors: 'active' });
    for (const unit of units) await executor.execOrThrow(restartUnitCommand(unit));
    ui.success('systemd units restarted');
  } else if (app.appType === 'backend' && namespace) {
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

const MISE = 'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"';

/**
 * Blue-green rollback: send traffic back to the previous colour.
 *
 * With retention `rollback` that colour is still running, so this is an instant
 * flip. With `warm` (the default) it was stopped after the last flip, so it is
 * booted again from the release it ran — `current` is pointed back at that
 * release first, because the colour's launcher files resolve through `current` —
 * health-checked, and only then does traffic move. The colour that was serving
 * is stopped afterwards, so memory stays at one copy.
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
      'Blue-green rollback is disabled because blueGreenRetention is "none". ' +
      'Use "warm" to keep rollback without holding the old colour in memory, or redeploy the desired release.',
    );
  }

  if (stepsBack !== 1) {
    throw new Error(
      `Blue-green rollback only supports one step (the previous colour). ` +
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

  const online = await isColourOnline(executor, app, namespace, webApp.name, previous);

  ui.warn(`Active colour:   ${state.activeColor} (port ${portFor(state.activeColor, state)})`);
  ui.warn(`Rollback target: ${previous} (port ${previousPort})`);

  let bootFrom: string | undefined;
  if (online) {
    if (!(await ask('Flip traffic back to the previous colour?'))) {
      ui.info('Rollback cancelled.');
      return;
    }
  } else {
    const release = releaseFor(state, previous);
    if (release === undefined) {
      throw new Error(
        `Previous colour "${previousName}" is stopped and the server did not record which release it ran ` +
        `(its state predates warm rollback). Redeploy the desired release instead.`,
      );
    }
    const onDisk = await executor.exec(`test -d "${appPath}/releases/${release}"`);
    if (onDisk.exitCode !== 0) {
      throw new Error(
        `Release ${release} is no longer on the server (older releases are cleaned up after keepReleases). ` +
        `Redeploy the desired release instead.`,
      );
    }
    ui.warn(`"${previousName}" is stopped; it will be started again from release ${release}.`);
    if (!(await ask(`Start ${previous} from release ${release} and flip traffic to it?`))) {
      ui.info('Rollback cancelled.');
      return;
    }
    bootFrom = release;
  }

  if (bootFrom !== undefined) {
    await bootColourFromRelease({
      executor, config, app, appPath, namespace, webApp, color: previous, port: previousPort, release: bootFrom,
    });
  }

  const caddy = new CaddyService(executor, config);
  await caddy.configureBackend(app, previousPort);
  await caddy.reload();
  await writeDeployState(executor, appPath, { ...state, activeColor: previous });

  // The colour that was serving is no longer needed: keep one copy in memory.
  if (app.blueGreenRetention === 'warm') {
    await executor.execOrThrow(reapColourCommand(app, namespace, webApp.name, state.activeColor));
  }

  ui.success(`Rolled back — traffic now on ${previous} (port ${previousPort})`);
}

/** Whether the web process of one colour is running right now. */
async function isColourOnline(
  executor: RemoteExecutor,
  app: ShipnodeApp,
  namespace: string,
  webName: string,
  color: DeployColor,
): Promise<boolean> {
  if (isWatt(app)) {
    return (await executor.exec(isActiveCommand(wattUnitName(namespace, webName, color)))).exitCode === 0;
  }
  // Parse pm2's JSON in-process rather than relying on `node` being on the
  // remote PATH at rollback time.
  const name = coloredWebName(namespace, webName, color);
  const jlist = await executor.exec(`${MISE} && mise exec -- pm2 jlist`);
  try {
    const entries = JSON.parse(jlist.stdout.trim()) as Array<{ name: string; pm2_env?: { status?: string } }>;
    return entries.some((e) => e.name === name && e.pm2_env?.status === 'online');
  } catch {
    return false;
  }
}

interface BootColourInput {
  executor: RemoteExecutor;
  config: ShipnodeConfig;
  app: ShipnodeApp;
  appPath: string;
  namespace: string;
  webApp: Pm2App;
  color: DeployColor;
  port: number;
  release: string;
}

/**
 * Start a stopped colour from the release it ran and wait until it is healthy.
 *
 * `current` is pointed at that release for the start and left there on success,
 * since the colour's launcher resolves its files through `current`. On failure
 * the colour is stopped again and `current` is put back, so a rollback that
 * cannot start leaves the app exactly as it was.
 */
async function bootColourFromRelease(input: BootColourInput): Promise<void> {
  const { executor, config, app, appPath, namespace, webApp, color, port, release } = input;
  const releases = new ReleaseManager(executor, appPath, app.keepReleases);
  const before = (await executor.exec(`readlink "${appPath}/current"`)).stdout.trim();

  await releases.switchSymlink(`${appPath}/releases/${release}`);
  try {
    if (isWatt(app)) {
      await executor.execOrThrow(enableAndStartUnitCommand(wattUnitName(namespace, webApp.name, color)));
    } else {
      await executor.execOrThrow(
        `cd "${appPath}/current" && ${MISE} && ` +
        `mise exec -- pm2 start "${appPath}/current/ecosystem.web.config.cjs" --update-env && ` +
        `mise exec -- pm2 save`,
      );
    }
    if (app.healthCheck.enabled) {
      ui.info(`Waiting for ${color} to pass its health check...`);
      await new HealthCheckService(executor, config).perform(app, {
        httpPort: port,
        pm2Apps: [webApp],
        resolvePm2Name: (a: Pm2App) => coloredWebName(namespace, a.name, color),
      });
    }
  } catch (error) {
    await executor.exec(reapColourCommand(app, namespace, webApp.name, color));
    if (before !== '') {
      try {
        await releases.switchSymlink(before);
      } catch {
        // Don't let a failed restore hide why the start failed: say where
        // `current` is left and how to put it back, then rethrow the original.
        ui.warn(
          `Could not point current back at its previous release. It still points at ${appPath}/releases/${release}; ` +
          `restore it with: ln -sfn "${before}" "${appPath}/current"`,
        );
      }
    }
    throw error;
  }
}

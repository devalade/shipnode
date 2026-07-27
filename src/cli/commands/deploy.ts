import chalk from 'chalk';
import { Result, type Result as ResultType } from 'better-result';
import { loadConfig } from '../../config/loader.js';
import { DeployService } from '../../services/deploy.service.js';
import { LoggingExecutor } from '../../infrastructure/ssh/logging-executor.js';
import { runRemoteCommandForTargets } from '../runner.js';
import { ui } from '../ui.js';
import type { AccessoryConfig, ShipnodeConfig, ShipnodeApp } from '../../shared/types.js';
import { accessoryMounts } from '../../services/accessory.service.js';
import { getPm2Name } from '../../domain/pm2/apps.js';
import { configForAppResult, configForServer, getServerTargets, resolveServerNames, resolveSingleServerNameResult } from '../../domain/servers.js';
import { generateBackendCaddyfile, generateFleetCaddyfile, generateFrontendCaddyfile } from '../../services/caddy.service.js';
import { appStateDir } from '../../domain/deploy/drain.js';
import { type ServerTargetError } from '../../shared/result-errors.js';
import { runDeployWatch } from './deploy-watch.js';
import type { BuildLocation } from '../../domain/deploy/hot-sync.js';
import { deployFleet, type FleetEvent } from '../../domain/deploy/fleet.js';
import { SshConnection } from '../../infrastructure/ssh/connection.js';

export async function cmdDeploy(cwd: string, options: { dryRun?: boolean; skipBuild?: boolean; app?: string; config?: string; watch?: boolean; build?: string; on?: string }): Promise<void> {
  let config: ShipnodeConfig;
  let targetConfig: ShipnodeConfig;
  try {
    config = await loadConfig(cwd, options.config);
    if (options.app) {
      const selected = configForAppResult(config, options.app);
      if (selected.isErr()) {
        ui.error(selected.error.message);
        process.exit(1);
        return;
      }
      targetConfig = selected.value;
    } else {
      targetConfig = config;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.error(message);
    process.exit(1);
    return;
  }

  if (options.dryRun) {
    if (options.watch) {
      ui.error('--watch and --dry-run are mutually exclusive.');
      process.exit(1);
      return;
    }
    printDryRun(targetConfig, options.skipBuild ?? false);
    return;
  }

  if (options.watch) {
    await startWatch(cwd, config, options);
    return;
  }

  // Check --on against what was actually asked for, before opening any
  // connection. Otherwise `--app api --on db-1` dials a server api does not run
  // on and fails with an SSH timeout instead of saying so.
  if (options.on) {
    const reachable = getServerTargets(targetConfig).map((target) => target.name);
    if (!reachable.includes(options.on)) {
      ui.error(
        options.app
          ? `App '${options.app}' does not run on '${options.on}'. It runs on: ${reachable.join(', ')}`
          : `Unknown server target '${options.on}'. Known targets: ${reachable.join(', ')}`,
      );
      process.exit(1);
      return;
    }
  }

  // The per-server config the callback receives only carries that server's own
  // accessories, so cross-server dependencies are invisible from inside it.
  // Dependency warnings have to be resolved against the whole workspace.
  const workspaceConfig = config;
  const fleetApps = targetConfig.apps.filter((candidate) => candidate.fleet);
  const soloApps = targetConfig.apps.filter((candidate) => !candidate.fleet);

  // Naming a fleet app leaves the fan-out with nothing to do — rolling it is
  // the whole job, and visiting other servers would deploy things not asked for.
  const fanOut = soloApps.length > 0 || !options.app;

  // Accessories and single-server apps go server by server, as they always
  // have. Fleet apps cannot: they appear on several servers at once and must be
  // rolled one batch at a time, so they are held back and handled after — which
  // also means the accessories they depend on are already up.
  if (fanOut) await runRemoteCommandForTargets(
    cwd,
    async ({ config, executor, serverName }) => {
      const serverApps = config.apps.filter((candidate) => !candidate.fleet);
      const app = options.app ? serverApps.find((candidate) => candidate.name === options.app) : undefined;
      const deployConfig = options.app
        ? { ...config, apps: app ? [app] : [] }
        : { ...config, apps: serverApps };
      if (deployConfig.apps.length === 0 && Object.keys(deployConfig.accessories ?? {}).length === 0) return;

      ui.banner();
      const names = deployConfig.apps.map((a) => a.name).join(', ');
      const label = names || Object.keys(deployConfig.accessories ?? {}).join(', ');
      ui.step(`Deploying ${chalk.bold(label)} → ${serverName} (${config.ssh.user}@${config.ssh.host})`);

      for (const deployingApp of deployConfig.apps) {
        for (const warning of renderDependencyWarnings(workspaceConfig, deployingApp)) {
          ui.warn(warning);
        }
      }

      const deployer = new DeployService(new LoggingExecutor(executor), deployConfig);
      await deployer.execute(cwd, options.skipBuild ?? false);

      const lines: string[] = [
        `host     ${config.ssh.user}@${config.ssh.host}`,
      ];
      for (const deployedApp of deployConfig.apps) {
        if (deployedApp.domain) lines.push(`url      https://${deployedApp.domain}`);
      }

      ui.note(lines.join('\n'), 'Done');
    },
    { configPath: options.config, serverName: options.on, appName: options.app },
  );

  for (const fleetApp of fleetApps) {
    await rollFleetApp(cwd, workspaceConfig, fleetApp, options);
  }

  ui.outro('Run shipnode status to check your app.');
}

/**
 * Roll one app across its replicas.
 *
 * Each replica gets the workspace narrowed to just this app and just that
 * server, so the deploy that runs on it is exactly the single-server deploy —
 * same orchestrator, same blue-green, same health check. Accessories are
 * stripped because the fan-out above has already ensured them; leaving them in
 * would restart the database once per replica.
 */
async function rollFleetApp(
  cwd: string,
  config: ShipnodeConfig,
  app: ShipnodeApp,
  options: { skipBuild?: boolean; on?: string },
): Promise<void> {
  const scoped = configForAppResult(config, app.name);
  if (scoped.isErr()) {
    ui.error(scoped.error.message);
    process.exit(1);
    return;
  }

  const appConfig = scoped.value;
  const allReplicas = getServerTargets(appConfig).map((target) => target.name);
  let replicas = allReplicas;
  if (options.on) {
    if (!replicas.includes(options.on)) {
      ui.error(`App '${app.name}' does not run on '${options.on}'. It runs on: ${replicas.join(', ')}`);
      process.exit(1);
      return;
    }
    replicas = [options.on];
  }

  ui.banner();
  ui.step(`Rolling ${chalk.bold(app.name)} across ${replicas.join(', ')}`);

  for (const warning of renderFleetWarnings(app, replicas)) ui.warn(`${app.name}: ${warning}`);
  for (const warning of renderDependencyWarnings(config, app)) ui.warn(warning);

  const result = await deployFleet({
    app,
    fleet: app.fleet!,
    replicas,
    // From the full list, not the narrowed one: `--on web-b` must not promote
    // web-b to primary and start a second copy of the scheduler alongside web-a's.
    primary: allReplicas[0],
    remotePath: appConfig.remotePath,
    connect: async (serverName) => {
      const ssh = new SshConnection();
      await ssh.connect(configForServer(appConfig, serverName).ssh);
      return { executor: ssh, close: () => ssh.disconnect() };
    },
    deployReplica: async ({ serverName, executor, releaseId, role }) => {
      const replicaConfig = { ...configForServer(appConfig, serverName), apps: [app], accessories: {} };
      const deployer = new DeployService(new LoggingExecutor(executor), replicaConfig);
      await deployer.execute(cwd, options.skipBuild ?? false, releaseId, role);
    },
    onEvent: (event) => reportFleetEvent(app, event),
  });

  if (result.failed) {
    ui.error(
      `${app.name}: ${result.failed.server} failed and is out of rotation. ` +
      `${result.deployed.length ? `${result.deployed.join(', ')} now on ${result.releaseId}; ` : ''}` +
      `${result.skipped.length ? `${result.skipped.join(', ')} still on the previous release. ` : ''}` +
      `The fleet is running mixed versions.`,
    );
    process.exit(1);
    return;
  }

  ui.note(
    [`release  ${result.releaseId}`, `servers  ${result.deployed.join(', ')}`, ...(app.domain ? [`url      https://${app.domain}`] : [])].join('\n'),
    `${app.name} rolled`,
  );
}

function reportFleetEvent(app: ShipnodeApp, event: FleetEvent): void {
  switch (event.type) {
    case 'drained':
      ui.info(`${event.servers.join(', ')} draining — waiting ${event.waitSeconds}s for the load balancer`);
      break;
    case 'deploying':
      ui.step(`${app.name} → ${event.server}`);
      break;
    case 'undrained':
      ui.success(`${event.server} back in rotation`);
      break;
    case 'failed':
      ui.error(`${event.server}: ${event.message}`);
      break;
    default:
      break;
  }
}

/**
 * Where each watch cycle builds.
 *
 * Explicit `--build` wins. Otherwise `--skip-build` means the developer builds
 * (or their framework's own watch mode does), a frontend always builds locally,
 * and a backend defaults to the server — matching the plain deploy path.
 * Returns undefined for an unrecognised `--build` value.
 */
function resolveBuildLocation(
  options: { skipBuild?: boolean; build?: string },
  app: ShipnodeApp,
): BuildLocation | undefined {
  if (options.build !== undefined) {
    const known: BuildLocation[] = ['remote', 'local', 'none'];
    return known.find((candidate) => candidate === options.build);
  }
  if (options.skipBuild) return 'none';
  return app.appType === 'frontend' ? 'local' : 'remote';
}

/**
 * Watch mode targets exactly one app on one server: it holds a single SSH
 * session open and reloads one process set, so "which app" must be
 * unambiguous rather than inferred.
 */
async function startWatch(
  cwd: string,
  config: ShipnodeConfig,
  options: { skipBuild?: boolean; app?: string; build?: string; on?: string },
): Promise<void> {
  const appName = options.app ?? (config.apps.length === 1 ? config.apps[0]?.name : undefined);

  if (!appName) {
    const known = config.apps.map((app) => app.name).join(', ');
    ui.error(
      config.apps.length === 0
        ? 'No apps configured to watch.'
        : `This workspace has ${config.apps.length} apps — pick one with --app <name>. Known apps: ${known}`,
    );
    process.exit(1);
    return;
  }

  const scoped = configForAppResult(config, appName);
  if (scoped.isErr()) {
    ui.error(scoped.error.message);
    process.exit(1);
    return;
  }

  let watchConfig = scoped.value;
  const app = watchConfig.apps[0];

  // A watch session holds one SSH connection and reloads one process set, so a
  // fleet app has to be narrowed to a single replica. Patching the live release
  // of every replica in lockstep is not something this loop can promise.
  const replicas = getServerTargets(watchConfig).map((target) => target.name);
  if (replicas.length > 1) {
    if (!options.on) {
      ui.error(
        `'${appName}' runs on ${replicas.length} servers (${replicas.join(', ')}). ` +
        `Watch mode patches one live release — pick a replica with --on <server>.`,
      );
      process.exit(1);
      return;
    }
    if (!replicas.includes(options.on)) {
      ui.error(`'${appName}' does not run on '${options.on}'. It runs on: ${replicas.join(', ')}`);
      process.exit(1);
      return;
    }
  }
  if (options.on) {
    watchConfig = configForServer(watchConfig, options.on);
  }

  const buildLocation = resolveBuildLocation(options, app);
  if (!buildLocation) {
    ui.error(`--build must be one of: remote, local, none (got "${options.build}")`);
    process.exit(1);
    return;
  }

  try {
    await runDeployWatch(cwd, watchConfig, app, { buildLocation });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.error(message);
    process.exit(1);
  }
}

function renderAppPlan(config: ShipnodeConfig, app: ShipnodeApp, skipBuild: boolean): string {
  const namespace = app.pm2?.apps[0]?.name;
  const web = app.pm2?.apps.find((a) => a.port !== undefined);

  const replicas = resolveServerNames(config, app.on);
  const serverRows: [string, string][] = [
    ['App type', app.appType],
    [replicas.length > 1 ? 'Servers' : 'Server', replicas.join(', ')],
    ['App root', app.appRoot ?? '(repo root)'],
    ['Keep releases', String(app.keepReleases)],
  ];

  if (app.fleet) {
    serverRows.push(['Rolling', `${app.fleet.batch} at a time, ${app.fleet.drainWait}s drain`]);
    serverRows.push(['Ready path', `:${app.fleet.port}${app.fleet.readyPath}`]);
  }

  if (app.appType === 'backend') {
    const pm2Apps = app.pm2?.apps ?? [];
    if (pm2Apps.length && namespace) {
      serverRows.push(['PM2 deployment', namespace]);
      serverRows.push([
        'PM2 apps',
        pm2Apps
          .map((a) => {
            const name = getPm2Name(namespace, a.name);
            if (a.port !== undefined) return `${name}(web:${a.port})`;
            // Where a pinned worker actually lands is the thing worth checking
            // before the first roll — say it rather than leave it implied.
            if (a.placement === 'primary' && replicas.length > 1) return `${name}(${replicas[0]} only)`;
            return name;
          })
          .join(', '),
      ]);
    }
    if (web) serverRows.push(['Port', String(web.port)]);
  }

  if (app.domain) serverRows.push(['Domain', app.domain]);
  if (app.dependsOn?.length) serverRows.push(['Depends on', app.dependsOn.join(', ')]);

  const dependencyWarnings = renderDependencyWarnings(config, app);
  const fleetWarnings = renderFleetWarnings(app, replicas);

  const caddyPreview = renderCaddyPreview(config, app);

  const buildRows: [string, string][] = [];
  if (skipBuild) {
    buildRows.push(['', chalk.dim('skipped (--skip-build)')]);
  } else if (app.appType === 'frontend') {
    buildRows.push(['', 'npm run build']);
    buildRows.push(['output', app.buildDir ?? 'dist/ (auto-detected)']);
  } else {
    buildRows.push(['', chalk.dim('runs on remote server')]);
  }

  const steps: string[] = [];
  if (app.fleet) {
    const batch = app.fleet.batch === 1 ? 'one replica' : `${app.fleet.batch} replicas`;
    steps.push(
      `Drain ${batch} (${app.fleet.readyPath} → 503)`,
      `Wait ${app.fleet.drainWait}s for the load balancer to notice`,
    );
  }
  steps.push(
    'Acquire deploy lock',
    'Create release directory',
    'Rsync files',
    'Install dependencies',
  );
  if (app.hooks?.beforeFleet) steps.push('Run beforeFleet hook (first replica only)');
  if (app.hooks?.preDeploy) steps.push('Run preDeploy hook');
  steps.push('Switch symlink (atomic)');
  if (app.appType === 'backend') steps.push('Reload PM2');
  if (app.healthCheck.enabled) steps.push(`Health check ${app.healthCheck.path}`);
  steps.push('Record release');
  if (app.hooks?.postDeploy) steps.push('Run postDeploy hook');
  if (app.hooks?.afterFleet) steps.push('Run afterFleet hook (last replica only)');
  steps.push('Clean old releases', 'Release lock');
  if (app.fleet) {
    steps.push(`Undrain (${app.fleet.readyPath} → 200)`, 'Repeat for the next batch');
  }

  const flowRows: [string, string][] = steps.map((step, i) => [`${i + 1}.`, step]);

  return [
    chalk.bold(`App: ${app.name}`),
    ...serverRows.map(([k, v]) => `  ${chalk.dim(k.padEnd(14))} ${v}`),
    '',
    chalk.bold('  Build'),
    ...buildRows.map(([k, v]) => `  ${chalk.dim(k.padEnd(14))} ${v}`),
    '',
    chalk.bold('  Deploy flow'),
    ...flowRows.map(([k, v]) => `    ${chalk.dim(k.padEnd(4))} ${v}`),
    ...(fleetWarnings.length ? ['', chalk.bold('  Fleet hints'), ...fleetWarnings.map((line) => `    ${line}`)] : []),
    ...(dependencyWarnings.length ? ['', chalk.bold('  Dependency hints'), ...dependencyWarnings.map((line) => `    ${line}`)] : []),
    ...(caddyPreview ? ['', chalk.bold('  Caddy'), caddyPreview.split('\n').map((line) => `    ${line}`).join('\n')] : []),
  ].join('\n');
}

/**
 * Caveats that only bite once an app has more than one replica, and that the
 * config itself cannot decide for you.
 */
function renderFleetWarnings(app: ShipnodeApp, replicas: string[]): string[] {
  if (replicas.length < 2) return [];
  const warnings: string[] = [];

  if (app.hooks?.preDeploy) {
    warnings.push(
      `preDeploy runs once per replica — ${replicas.length} times for this roll. ` +
      `Move database migrations to .beforeFleet(), which runs once.`,
    );
  }

  return warnings;
}

function renderDependencyWarnings(config: ShipnodeConfig, app: ShipnodeApp): string[] {
  const dependencies = app.dependsOn ?? [];
  if (dependencies.length === 0) return [];

  const appServers = resolveServerNames(config, app.on);
  const warnings: string[] = [];
  for (const name of dependencies) {
    const accessory = config.accessories?.[name];
    if (!accessory) continue;
    const [accessoryServer] = resolveServerNames(config, accessory.on);
    if (accessoryServer === undefined) continue;
    const strangers = appServers.filter((server) => server !== accessoryServer);
    if (strangers.length > 0) {
      warnings.push(
        `${name} runs on ${accessoryServer}; ${app.name} runs on ${strangers.join(', ')}. ` +
        `Confirm reachable networking.`,
      );
    }
  }
  return warnings;
}

function renderCaddyPreview(config: ShipnodeConfig, app: ShipnodeApp): string | null {
  const servePath = `${config.remotePath}/${app.name}/current`;
  const web = app.pm2?.apps.find((pm2App) => pm2App.port !== undefined);

  // A replica serves a private port and never claims the domain — showing the
  // public site here would preview a file shipnode is not going to write.
  if (app.fleet) {
    const [firstReplica] = resolveServerNames(config, app.on);
    return generateFleetCaddyfile(app, {
      listen: app.fleet.port,
      bind: firstReplica ? config.servers[firstReplica]?.privateHost : undefined,
      upstream: web?.port,
      servePath: app.appType === 'frontend' ? servePath : undefined,
      readyPath: app.fleet.readyPath,
      stateDir: appStateDir(config.remotePath, app.name),
    });
  }

  if (!app.domain) return null;
  if (app.appType === 'frontend') {
    return generateFrontendCaddyfile(app, servePath);
  }
  if (!web?.port) return null;
  return generateBackendCaddyfile(app, web.port);
}

export function printDryRun(config: ShipnodeConfig, skipBuild: boolean): void {
  ui.banner();

  const servers = getServerTargets(config).map((target) => `${target.name}=${target.ssh.user}@${target.ssh.host}:${target.ssh.port}`).join(', ');
  const header = [
    chalk.bold('Workspace'),
    `  ${chalk.dim('Servers'.padEnd(14))} ${servers}`,
    `  ${chalk.dim('Remote path'.padEnd(14))} ${config.remotePath}`,
    `  ${chalk.dim('Node'.padEnd(14))} ${config.nodeVersion}`,
    `  ${chalk.dim('Apps'.padEnd(14))} ${config.apps.map((a) => a.name).join(', ')}`,
  ].join('\n');

  // Per app, not per server: a fleet app runs on several servers and would
  // otherwise be printed once for each of them.
  const perApp = config.apps
    .map((app) => renderAppPlan(config, app, skipBuild))
    .join('\n\n');

  const accessories = renderAccessoriesPlan(config);
  if (accessories.isErr()) {
    ui.error(accessories.error.message);
    process.exit(1);
    return;
  }

  const output = [header, ''];
  if (perApp) output.push(perApp);
  if (accessories.value) output.push(accessories.value);
  ui.note(output.join('\n'), 'Dry run — no changes will be made');
}

function renderAccessoriesPlan(config: ShipnodeConfig): ResultType<string, ServerTargetError> {
  const accessories = Object.entries(config.accessories ?? {});
  if (accessories.length === 0) return Result.ok('');

  const rendered: string[] = [chalk.bold('Accessories')];
  for (const [name, accessory] of accessories) {
    const server = resolveAccessoryServer(config, accessory);
    if (server.isErr()) return Result.err(server.error);

    rendered.push(renderAccessoryPlan(name, accessory, server.value, config));
  }

  return Result.ok(rendered.join('\n\n'));
}

function resolveAccessoryServer(
  config: ShipnodeConfig,
  accessory: AccessoryConfig,
): ResultType<string, ServerTargetError> {
  return resolveSingleServerNameResult(config, accessory.on, 'This accessory');
}

function renderAccessoryPlan(
  name: string,
  accessory: AccessoryConfig,
  serverName: string,
  config: ShipnodeConfig,
): string {
  const registry = accessory.registry ?? config.registry;
  const ports = Array.isArray(accessory.port) ? accessory.port : accessory.port ? [accessory.port] : [];
  const rows: [string, string][] = [
    ['Server', serverName],
    ['Image', accessory.image],
  ];

  if (ports.length > 0) rows.push(['Ports', ports.join(', ')]);
  const mounts = accessoryMounts(accessory);
  if (mounts.length > 0) rows.push(['Volumes', mounts.join(', ')]);
  if (accessory.networks?.length) rows.push(['Networks', accessory.networks.join(', ')]);
  if (accessory.command) rows.push(['Command', Array.isArray(accessory.command) ? accessory.command.join(' ') : accessory.command]);
  if (accessory.labels && Object.keys(accessory.labels).length > 0) rows.push(['Labels', Object.entries(accessory.labels).map(([key, value]) => `${key}=${value}`).join(', ')]);
  if (accessory.restart) rows.push(['Restart', accessory.restart]);
  if (accessory.resources) rows.push(['Resources', renderAccessoryResources(accessory.resources)]);
  if (accessory.stopTimeout !== undefined) rows.push(['Stop timeout', `${accessory.stopTimeout}s`]);
  if (registry) rows.push(['Registry', `${registry.server} (${registry.passwordEnv})`]);
  if (accessory.healthCheck) rows.push(['Health check', accessory.healthCheck.command]);

  const hasVolumeSetup = mounts.some((mount) => {
    const [source] = mount.split(':');
    return source !== undefined && source !== '' && !source.startsWith('/') && !source.startsWith('.') && !source.startsWith('~');
  });
  const hasNetworkSetup = (accessory.networks ?? []).length > 0;
  const setupSteps = [
    ...(hasVolumeSetup ? ['Inspect/create named Docker volumes'] : []),
    ...(hasNetworkSetup ? ['Inspect/create Docker networks'] : []),
  ];
  const dockerSteps = [
    registry ? `Login to ${registry.server} using $${registry.passwordEnv}` : 'Skip registry login',
    ...setupSteps,
    `Pull ${accessory.image}`,
    `Recreate container shipnode-${name}`,
    ...(accessory.healthCheck ? ['Run health check'] : []),
  ];

  return [
    chalk.bold(`Accessory: ${name}`),
    ...rows.map(([key, value]) => `  ${chalk.dim(key.padEnd(14))} ${value}`),
    '',
    chalk.bold('  Docker flow'),
    ...dockerSteps.map((step, index) => `    ${chalk.dim(`${index + 1}.`.padEnd(4))} ${step}`),
  ].join('\n');
}

function renderAccessoryResources(resources: NonNullable<AccessoryConfig['resources']>): string {
  const parts: string[] = [];
  if (resources.memory) parts.push(`memory=${resources.memory}`);
  if (resources.memoryReservation) parts.push(`memoryReservation=${resources.memoryReservation}`);
  if (resources.cpus) parts.push(`cpus=${resources.cpus}`);
  return parts.join(', ');
}

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
import { configForAppResult, configForServer, getServerTargets, resolveServerName, resolveServerNameResult } from '../../domain/servers.js';
import { generateBackendCaddyfile, generateFrontendCaddyfile } from '../../services/caddy.service.js';
import { type ServerTargetError } from '../../shared/result-errors.js';
import { runDeployWatch } from './deploy-watch.js';
import type { BuildLocation } from '../../domain/deploy/hot-sync.js';

export async function cmdDeploy(cwd: string, options: { dryRun?: boolean; skipBuild?: boolean; app?: string; config?: string; watch?: boolean; build?: string }): Promise<void> {
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

  await runRemoteCommandForTargets(
    cwd,
    async ({ config, executor, serverName }) => {
      const app = options.app ? config.apps.find((candidate) => candidate.name === options.app) : undefined;
      const deployConfig = options.app
        ? { ...config, apps: app ? [app] : [] }
        : config;
      if (deployConfig.apps.length === 0 && Object.keys(deployConfig.accessories ?? {}).length === 0) return;

      ui.banner();
      const names = deployConfig.apps.map((a) => a.name).join(', ');
      const label = names || Object.keys(deployConfig.accessories ?? {}).join(', ');
      ui.step(`Deploying ${chalk.bold(label)} → ${serverName} (${config.ssh.user}@${config.ssh.host})`);

      const deployer = new DeployService(new LoggingExecutor(executor), deployConfig);
      await deployer.execute(cwd, options.skipBuild ?? false);

      const lines: string[] = [
        `host     ${config.ssh.user}@${config.ssh.host}`,
      ];
      for (const deployedApp of deployConfig.apps) {
        if (deployedApp.domain) lines.push(`url      https://${deployedApp.domain}`);
      }

      ui.note(lines.join('\n'), 'Done');
      ui.outro('Run shipnode status to check your app.');
    },
    { configPath: options.config },
  );
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
  options: { skipBuild?: boolean; app?: string; build?: string },
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

  const watchConfig = scoped.value;
  const app = watchConfig.apps[0];

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

  const serverRows: [string, string][] = [
    ['App type', app.appType],
    ['Server', resolveServerName(config, app.on)],
    ['App root', app.appRoot ?? '(repo root)'],
    ['Keep releases', String(app.keepReleases)],
  ];

  if (app.appType === 'backend') {
    const pm2Apps = app.pm2?.apps ?? [];
    if (pm2Apps.length && namespace) {
      serverRows.push(['PM2 deployment', namespace]);
      serverRows.push([
        'PM2 apps',
        pm2Apps
          .map((a) =>
            a.port !== undefined
              ? `${getPm2Name(namespace, a.name)}(web:${a.port})`
              : getPm2Name(namespace, a.name),
          )
          .join(', '),
      ]);
    }
    if (web) serverRows.push(['Port', String(web.port)]);
  }

  if (app.domain) serverRows.push(['Domain', app.domain]);
  if (app.dependsOn?.length) serverRows.push(['Depends on', app.dependsOn.join(', ')]);

  const dependencyWarnings = renderDependencyWarnings(config, app);

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

  const steps: string[] = [
    'Acquire deploy lock',
    'Create release directory',
    'Rsync files',
    'Install dependencies',
  ];
  if (app.hooks?.preDeploy) steps.push('Run preDeploy hook');
  steps.push('Switch symlink (atomic)');
  if (app.appType === 'backend') steps.push('Reload PM2');
  if (app.healthCheck.enabled) steps.push(`Health check ${app.healthCheck.path}`);
  steps.push('Record release', 'Clean old releases');
  if (app.hooks?.postDeploy) steps.push('Run postDeploy hook');
  steps.push('Release lock');

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
    ...(dependencyWarnings.length ? ['', chalk.bold('  Dependency hints'), ...dependencyWarnings.map((line) => `    ${line}`)] : []),
    ...(caddyPreview ? ['', chalk.bold('  Caddy'), caddyPreview.split('\n').map((line) => `    ${line}`).join('\n')] : []),
  ].join('\n');
}

function renderDependencyWarnings(config: ShipnodeConfig, app: ShipnodeApp): string[] {
  const dependencies = app.dependsOn ?? [];
  if (dependencies.length === 0) return [];

  const appServer = resolveServerName(config, app.on);
  const warnings: string[] = [];
  for (const name of dependencies) {
    const accessory = config.accessories?.[name];
    if (!accessory) continue;
    const accessoryServer = resolveServerName(config, accessory.on);
    if (appServer !== accessoryServer) {
      warnings.push(`${name} runs on ${accessoryServer}; ${app.name} runs on ${appServer}. Confirm reachable networking.`);
    }
  }
  return warnings;
}

function renderCaddyPreview(config: ShipnodeConfig, app: ShipnodeApp): string | null {
  if (!app.domain) return null;
  if (app.appType === 'frontend') {
    return generateFrontendCaddyfile(app, `${config.remotePath}/${app.name}/current`);
  }
  const web = app.pm2?.apps.find((pm2App) => pm2App.port !== undefined);
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

  const perApp = getServerTargets(config)
    .map((target) => configForServer(config, target.name))
    .flatMap((targetConfig) => targetConfig.apps.map((app) => renderAppPlan(config, app, skipBuild)))
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
  return resolveServerNameResult(config, accessory.on);
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

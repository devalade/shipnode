import chalk from 'chalk';
import { loadConfig } from '../../config/loader.js';
import { DeployService } from '../../services/deploy.service.js';
import { LoggingExecutor } from '../../infrastructure/ssh/logging-executor.js';
import { runRemoteCommandForTargets } from '../runner.js';
import { ui } from '../ui.js';
import type { ShipnodeConfig, ShipnodeApp } from '../../shared/types.js';
import { getPm2Name } from '../../domain/pm2/apps.js';
import { configForAppResult, configForServer, getServerTargets, resolveServerName } from '../../domain/servers.js';
import { generateBackendCaddyfile, generateFrontendCaddyfile } from '../../services/caddy.service.js';

export async function cmdDeploy(cwd: string, options: { dryRun?: boolean; skipBuild?: boolean; app?: string; config?: string }): Promise<void> {
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
    printDryRun(targetConfig, options.skipBuild ?? false);
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

      const lines = [
        `host     ${config.ssh.user}@${config.ssh.host}`,
        ...deployConfig.apps.filter((a) => a.domain).map((a) => `url      https://${a.domain}`),
      ].filter(Boolean).join('\n');

      ui.note(lines, 'Done');
      ui.outro('Run shipnode status to check your app.');
    },
    { configPath: options.config },
  );
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

  const steps = [
    'Acquire deploy lock',
    'Create release directory',
    'Rsync files',
    'Install dependencies',
    app.hooks?.preDeploy ? 'Run preDeploy hook' : '',
    'Switch symlink (atomic)',
    app.appType === 'backend' ? 'Reload PM2' : '',
    app.healthCheck.enabled ? `Health check ${app.healthCheck.path}` : '',
    'Record release',
    'Clean old releases',
    app.hooks?.postDeploy ? 'Run postDeploy hook' : '',
    'Release lock',
  ].filter(Boolean);

  const flowRows: [string, string][] = steps.map((s, i) => [`${i + 1}.`, s as string]);

  return [
    chalk.bold(`App: ${app.name}`),
    ...serverRows.map(([k, v]) => `  ${chalk.dim(k.padEnd(14))} ${v}`),
    '',
    chalk.bold('  Build'),
    ...buildRows.map(([k, v]) => `  ${chalk.dim(k.padEnd(14))} ${v}`),
    '',
    chalk.bold('  Deploy flow'),
    ...flowRows.map(([k, v]) => `    ${chalk.dim(k.padEnd(4))} ${v}`),
    ...(caddyPreview ? ['', chalk.bold('  Caddy'), caddyPreview.split('\n').map((line) => `    ${line}`).join('\n')] : []),
  ].join('\n');
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

  ui.note([header, '', perApp].join('\n'), 'Dry run — no changes will be made');
}

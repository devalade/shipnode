import chalk from 'chalk';
import { loadConfig } from '../../config/loader.js';
import { DeployService } from '../../services/deploy.service.js';
import { LoggingExecutor } from '../../infrastructure/ssh/logging-executor.js';
import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';
import type { ShipnodeConfig, ShipnodeApp } from '../../shared/types.js';
import { getActiveApp } from '../../domain/workspace.js';
import { getPm2Name } from '../../domain/pm2/apps.js';

export async function cmdDeploy(cwd: string, options: { dryRun?: boolean; skipBuild?: boolean; app?: string; config?: string }): Promise<void> {
  const config = await loadConfig(cwd, options.config);
  const targetConfig = options.app
    ? { ...config, apps: [getActiveApp(config, options.app)] }
    : config;

  if (options.dryRun) {
    printDryRun(targetConfig, options.skipBuild ?? false);
    return;
  }

  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      const deployConfig = options.app
        ? { ...config, apps: [getActiveApp(config, options.app!)] }
        : config;

      ui.banner();
      const names = deployConfig.apps.map((a) => a.name).join(', ');
      ui.step(`Deploying ${chalk.bold(names)} → ${config.ssh.user}@${config.ssh.host}`);

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

function renderAppPlan(app: ShipnodeApp, skipBuild: boolean): string {
  const namespace = app.pm2?.apps[0]?.name;
  const web = app.pm2?.apps.find((a) => a.port !== undefined);

  const serverRows: [string, string][] = [
    ['App type', app.appType],
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
  ].join('\n');
}

function printDryRun(config: ShipnodeConfig, skipBuild: boolean): void {
  ui.banner();

  const header = [
    chalk.bold('Workspace'),
    `  ${chalk.dim('Host'.padEnd(14))} ${config.ssh.user}@${config.ssh.host}:${config.ssh.port}`,
    `  ${chalk.dim('Remote path'.padEnd(14))} ${config.remotePath}`,
    `  ${chalk.dim('Node'.padEnd(14))} ${config.nodeVersion}`,
    `  ${chalk.dim('Apps'.padEnd(14))} ${config.apps.map((a) => a.name).join(', ')}`,
  ].join('\n');

  const perApp = config.apps.map((app) => renderAppPlan(app, skipBuild)).join('\n\n');

  ui.note([header, '', perApp].join('\n'), 'Dry run — no changes will be made');
}

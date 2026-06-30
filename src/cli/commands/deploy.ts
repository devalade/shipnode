import chalk from 'chalk';
import { loadConfig } from '../../config/loader.js';
import { DeployService } from '../../services/deploy.service.js';
import { LoggingExecutor } from '../../infrastructure/ssh/logging-executor.js';
import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';
import type { ShipnodeConfig } from '../../shared/types.js';
import { getActiveApp } from '../../domain/workspace.js';
import { getDeploymentName, getWebApp } from '../../domain/pm2/apps.js';

export async function cmdDeploy(cwd: string, options: { dryRun?: boolean; skipBuild?: boolean; config?: string }): Promise<void> {
  const config = await loadConfig(cwd, options.config);

  if (options.dryRun) {
    printDryRun(config, options.skipBuild ?? false);
    return;
  }

  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      ui.banner();
      ui.step(`Deploying ${chalk.bold(getDeploymentName(config) ?? getActiveApp(config).appType)} → ${config.ssh.user}@${config.ssh.host}`);

      const deployer = new DeployService(new LoggingExecutor(executor), config);
      await deployer.execute(cwd, options.skipBuild ?? false);

      const lines = [
        `host     ${config.ssh.user}@${config.ssh.host}`,
        getActiveApp(config).domain ? `url      https://${getActiveApp(config).domain}` : '',
      ].filter(Boolean).join('\n');

      ui.note(lines, 'Done');
      ui.outro('Run shipnode status to check your app.');
    },
    { configPath: options.config },
  );
}

function printDryRun(config: ShipnodeConfig, skipBuild: boolean): void {
  ui.banner();

  const app = getActiveApp(config);

  const serverRows: [string, string][] = [
    ['App type', app.appType],
    ['Host', `${config.ssh.user}@${config.ssh.host}:${config.ssh.port}`],
    ['Remote path', config.remotePath],
    ['Keep releases', String(app.keepReleases)],
  ];

  if (app.appType === 'backend') {
    const apps = app.pm2?.apps ?? [];
    if (apps.length) {
      serverRows.push(['PM2 deployment', getDeploymentName(config) ?? '']);
      serverRows.push(['PM2 apps', apps.map((a) => a.port !== undefined ? `${a.name}(web:${a.port})` : a.name).join(', ')]);
    }
    const web = getWebApp(config);
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

  ui.note(
    [
      chalk.bold('Server'),
      ...serverRows.map(([k, v]) => `  ${chalk.dim(k.padEnd(12))} ${v}`),
      '',
      chalk.bold('Build'),
      ...buildRows.map(([k, v]) => `  ${chalk.dim(k.padEnd(12))} ${v}`),
      '',
      chalk.bold('Deploy flow'),
      ...flowRows.map(([k, v]) => `  ${chalk.dim(k.padEnd(4))} ${v}`),
    ].join('\n'),
    'Dry run — no changes will be made',
  );
}

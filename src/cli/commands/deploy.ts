import chalk from 'chalk';
import { loadConfig } from '../../config/loader.js';
import { DeployService } from '../../services/deploy.service.js';
import { LoggingExecutor } from '../../infrastructure/ssh/logging-executor.js';
import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';
import type { ShipnodeConfig } from '../../shared/types.js';

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
      ui.step(`Deploying ${chalk.bold(config.pm2?.name ?? config.app)} → ${config.ssh.user}@${config.ssh.host}`);

      const deployer = new DeployService(new LoggingExecutor(executor), config, cwd);
      await deployer.execute(options.skipBuild ?? false);

      const lines = [
        `host     ${config.ssh.user}@${config.ssh.host}`,
        config.domain ? `url      https://${config.domain}` : '',
      ].filter(Boolean).join('\n');

      ui.note(lines, 'Done');
      ui.outro('Run shipnode status to check your app.');
    },
    { configPath: options.config },
  );
}

function printDryRun(config: ShipnodeConfig, skipBuild: boolean): void {
  ui.banner();

  const serverRows: [string, string][] = [
    ['App type', config.app],
    ['Host', `${config.ssh.user}@${config.ssh.host}:${config.ssh.port}`],
    ['Remote path', config.remotePath],
    ['Keep releases', String(config.keepReleases)],
  ];

  if (config.app === 'backend') {
    if (config.pm2?.name) serverRows.push(['PM2 name', config.pm2.name]);
    serverRows.push(['Port', String(config.backend?.port ?? 3000)]);
  }

  if (config.domain) serverRows.push(['Domain', config.domain]);

  const buildRows: [string, string][] = [];
  if (skipBuild) {
    buildRows.push(['', chalk.dim('skipped (--skip-build)')]);
  } else if (config.app === 'frontend') {
    buildRows.push(['', 'npm run build']);
    buildRows.push(['output', config.buildDir ?? 'dist/ (auto-detected)']);
  } else {
    buildRows.push(['', chalk.dim('runs on remote server')]);
  }

  const steps = [
    'Acquire deploy lock',
    'Create release directory',
    'Rsync files',
    'Install dependencies',
    config.hooks?.preDeploy ? 'Run preDeploy hook' : '',
    'Switch symlink (atomic)',
    config.app === 'backend' ? 'Reload PM2' : '',
    config.healthCheck.enabled ? `Health check ${config.healthCheck.path}` : '',
    'Record release',
    'Clean old releases',
    config.hooks?.postDeploy ? 'Run postDeploy hook' : '',
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

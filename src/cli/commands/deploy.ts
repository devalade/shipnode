import { loadConfig } from '../../config/loader.js';
import { DeployService } from '../../services/deploy.service.js';
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
      ui.info(`Deploying ${config.app} to ${config.ssh.user}@${config.ssh.host}...`);
      ui.info('Connecting to server...');
      ui.success('Connected');

      const deployer = new DeployService(executor, config, cwd);
      await deployer.execute(options.skipBuild ?? false);

      ui.success('Deployment complete');
    },
    { configPath: options.config },
  );
}

function printDryRun(config: ShipnodeConfig, skipBuild: boolean): void {
  console.log('\n===========================================');
  console.log('        DEPLOYMENT DRY RUN MODE');
  console.log('===========================================\n');

  console.log('Configuration:');
  console.log(`  App Type:        ${config.app}`);
  console.log(`  SSH User:        ${config.ssh.user}`);
  console.log(`  SSH Host:        ${config.ssh.host}`);
  console.log(`  SSH Port:        ${config.ssh.port}`);
  console.log(`  Remote Path:     ${config.remotePath}`);
  console.log(`  Zero Downtime:   ${config.zeroDowntime}`);

  if (config.app === 'backend') {
    console.log(`  PM2 App Name:    ${config.pm2?.name ?? 'N/A'}`);
    console.log(`  Backend Port:    ${config.backend?.port ?? 3000}`);
  }

  if (config.domain) {
    console.log(`  Domain:          ${config.domain}`);
  }

  console.log('\nLocal Build Commands:');
  if (skipBuild) {
    console.log('  [SKIPPED via --skip-build flag]');
  } else if (config.app === 'frontend') {
    console.log('  1. npm run build (or detected package manager)');
    console.log('  2. Detected build output: dist/');
  } else {
    console.log('  [Backend builds happen on remote server]');
  }

  console.log('\nRemote Deployment Commands:');
  if (config.zeroDowntime) {
    console.log('  Mode: Zero-Downtime Deployment');
    console.log('\n  Deployment Flow:');
    console.log('    1. Acquire deployment lock');
    console.log('    2. Create new release directory');
    console.log('    3. Setup release structure');
    console.log('    4. Rsync local files to release directory');
    console.log('    5. Link shared resources');
    console.log('    6. Install dependencies');
    if (config.app === 'backend') {
      console.log('    7. Run pre-deploy hook (if configured)');
      console.log('    8. Atomic symlink switch');
      console.log('    9. Reload PM2');
      console.log('   10. Health check');
      console.log('   11. Record release');
      console.log('   12. Cleanup old releases');
      console.log('   13. Run post-deploy hook (if configured)');
      console.log('   14. Release deployment lock');
    } else {
      console.log('    7. Atomic symlink switch');
      console.log('    8. Record release');
      console.log('    9. Cleanup old releases');
      console.log('   10. Run post-deploy hook (if configured)');
      console.log('   11. Release deployment lock');
    }
  } else {
    console.log('  Mode: Legacy Deployment (Non-Zero-Downtime)');
    console.log('\n  Deployment Steps:');
    console.log('    1. Rsync files to remote path');
    console.log('    2. Install dependencies');
    if (config.app === 'backend') {
      console.log('    3. Reload PM2');
    }
    console.log('    4. Run post-deploy hook (if configured)');
  }

  if (config.domain) {
    console.log('\nCaddy Configuration:');
    console.log(`  - Reverse proxy: ${config.domain} -> localhost:${config.backend?.port ?? 3000}`);
  }

  console.log('\n===========================================');
  console.log('  DRY RUN COMPLETE - No changes made');
  console.log('===========================================\n');
}

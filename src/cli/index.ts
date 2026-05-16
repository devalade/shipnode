#!/usr/bin/env node

import { Command } from 'commander';
import { cmdInit } from './commands/init.js';
import { cmdDeploy } from './commands/deploy.js';
import { cmdSetup } from './commands/setup.js';
import { cmdDoctor } from './commands/doctor.js';
import { cmdStatus } from './commands/status.js';
import { cmdHelp } from './commands/help.js';

const program = new Command();

program
  .name('shipnode')
  .description('Deploy Node.js apps to a single VPS')
  .version('2.0.0');

program
  .command('init')
  .description('Initialize a new shipnode.config.ts')
  .option('--non-interactive', 'Generate config without prompts')
  .option('--print', 'Print config to stdout without writing file')
  .action((opts) => cmdInit(process.cwd(), opts));

program
  .command('setup')
  .description('Setup a new server with required dependencies')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdSetup(process.cwd(), opts));

program
  .command('deploy')
  .description('Deploy your application')
  .option('--dry-run', 'Show what would be deployed without making changes')
  .option('--skip-build', 'Skip the build step')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdDeploy(process.cwd(), opts));

program
  .command('doctor')
  .description('Check local and remote configuration')
  .option('--security', 'Run security audit instead of standard checks')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdDoctor(process.cwd(), opts));

program
  .command('status')
  .description('Check application status')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdStatus(process.cwd(), opts));

program
  .command('help')
  .description('Show help')
  .action(() => cmdHelp());

program.on('command:*', () => {
  console.error(`Unknown command. Run 'shipnode help' for usage.`);
  process.exit(1);
});

if (process.argv.length <= 2) {
  cmdHelp();
  process.exit(0);
}

program.parse();

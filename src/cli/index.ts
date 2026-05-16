#!/usr/bin/env node

import { Command } from 'commander';
import { cmdInit } from './commands/init.js';
import { cmdDeploy } from './commands/deploy.js';
import { cmdSetup } from './commands/setup.js';
import { cmdDoctor } from './commands/doctor.js';
import { cmdStatus } from './commands/status.js';
import { cmdRollback } from './commands/rollback.js';
import { cmdEnv } from './commands/env.js';
import { cmdUnlock } from './commands/unlock.js';
import { cmdRun } from './commands/run.js';
import { cmdHarden } from './commands/harden.js';
import { cmdMigrate } from './commands/migrate.js';
import { cmdCiGithub, cmdCiEnvSync } from './commands/ci.js';
import { cmdConfigShow, cmdConfigValidate, cmdConfigPath } from './commands/config.js';
import { cmdLogs } from './commands/logs.js';
import { cmdRestart } from './commands/restart.js';
import { cmdStop } from './commands/stop.js';
import { cmdMetrics } from './commands/metrics.js';
import { cmdEject } from './commands/eject.js';
import { cmdHelp } from './commands/help.js';

const program = new Command();

program
  .name('shipnode')
  .description('Deploy Node.js apps to a single VPS')
  .version('2.0.0');

// ── Core ──────────────────────────────────────────────────────────

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

// ── Release management ────────────────────────────────────────────

program
  .command('rollback')
  .description('Roll back to a previous release')
  .option('--steps <n>', 'Number of releases to go back', '1')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdRollback(process.cwd(), { steps: parseInt(opts.steps, 10), config: opts.config }));

program
  .command('migrate')
  .description('Migrate existing deploy to zero-downtime release structure')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdMigrate(process.cwd(), opts));

// ── Environment ───────────────────────────────────────────────────

program
  .command('env')
  .description('Upload local .env file to the server')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdEnv(process.cwd(), opts));

program
  .command('run [cmd...]')
  .description('Run a one-off command on the production server')
  .option('--tty', 'Force interactive TTY mode')
  .option('--config <path>', 'Use a specific config file')
  .action((cmdArgs: string[], opts) => cmdRun(process.cwd(), opts, cmdArgs));

// ── Process management ────────────────────────────────────────────

program
  .command('logs')
  .description('Show application logs')
  .option('--lines <n>', 'Number of log lines to show', '100')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdLogs(process.cwd(), { lines: parseInt(opts.lines, 10), config: opts.config }));

program
  .command('restart')
  .description('Restart the application')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdRestart(process.cwd(), opts));

program
  .command('stop')
  .description('Stop the application')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdStop(process.cwd(), opts));

program
  .command('metrics')
  .description('Open PM2 monitoring dashboard')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdMetrics(process.cwd(), opts));

// ── Security & maintenance ────────────────────────────────────────

program
  .command('harden')
  .description('Apply server security hardening (SSH, firewall, fail2ban)')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdHarden(process.cwd(), opts));

program
  .command('unlock')
  .description('Clear a stuck deployment lock')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdUnlock(process.cwd(), opts));

// ── CI/CD ─────────────────────────────────────────────────────────

const ci = program.command('ci').description('CI/CD integration');

ci.command('github')
  .description('Generate GitHub Actions deploy workflow')
  .action(() => cmdCiGithub(process.cwd()));

ci.command('env-sync')
  .description('Sync .env and config to GitHub repository secrets')
  .option('--all', 'Sync all .env variables without confirmation')
  .action((opts) => cmdCiEnvSync(process.cwd(), opts));

// ── Config ────────────────────────────────────────────────────────

const config = program.command('config').description('Manage configuration');

config.command('show')
  .description('Show resolved configuration')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdConfigShow(process.cwd(), opts));

config.command('validate')
  .description('Validate configuration file')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdConfigValidate(process.cwd(), opts));

config.command('path')
  .description('Print path to config file')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdConfigPath(process.cwd(), opts));

// ── Customization ─────────────────────────────────────────────────

program
  .command('eject [target]')
  .description('Eject PM2/Caddy templates for customization (pm2, caddy, all)')
  .action((target: string = 'all') => {
    const valid = ['pm2', 'caddy', 'all'];
    if (!valid.includes(target)) {
      console.error(`Unknown eject target: ${target}. Use: pm2, caddy, all`);
      process.exit(1);
    }
    return cmdEject(process.cwd(), target as 'pm2' | 'caddy' | 'all');
  });

// ── Help ──────────────────────────────────────────────────────────

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

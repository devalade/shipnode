#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
import { cmdMonitor } from './commands/monitor.js';
import { cmdEject } from './commands/eject.js';
import { cmdHelp } from './commands/help.js';
import { cmdUserAdd, cmdUserSync, cmdUserList, cmdUserRemove } from './commands/user.js';
import { cmdUpgrade } from './commands/upgrade.js';
import { cmdBackupSetup, cmdBackupRun, cmdBackupStatus, cmdBackupList, cmdBackupRestore } from './commands/backup.js';
import { cmdCloudflareInit, cmdCloudflareAudit, cmdCloudflareStatus } from './commands/cloudflare.js';
import {
  cmdAccessoryHealth,
  cmdAccessoryLogs,
  cmdAccessoryRestart,
  cmdAccessoryStatus,
  cmdAccessoryStop,
} from './commands/accessory.js';
import { cmdRegistryLogin, cmdSecretSet } from './commands/secrets.js';

// Read version from package.json so `shipnode --version` stays in sync with the published
// version automatically. The dist layout puts this file at dist/cli/index.js, so the
// package.json is two levels up.
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
const { version } = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

const program = new Command();

program
  .name('shipnode')
  .description('Deploy Node.js apps to a single VPS')
  .version(version);

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
  .option('--no-deploy-user', 'Skip creating the deploy user (advanced)')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdSetup(process.cwd(), opts));

program
  .command('deploy')
  .description('Deploy your application')
  .option('--dry-run', 'Show what would be deployed without making changes')
  .option('--skip-build', 'Skip the build step')
  .option('--app <name>', 'Deploy a specific app (default: all apps)')
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
  .option('--app <name>', 'Target a specific app')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdStatus(process.cwd(), opts));

// ── Release management ────────────────────────────────────────────

program
  .command('rollback')
  .description('Roll back to a previous release')
  .option('--steps <n>', 'Number of releases to go back', '1')
  .option('--app <name>', 'App to roll back (required)')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdRollback(process.cwd(), { steps: parseInt(opts.steps, 10), app: opts.app, config: opts.config }));

program
  .command('migrate')
  .description('Migrate existing deploy to zero-downtime release structure')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdMigrate(process.cwd(), opts));

// ── Environment ───────────────────────────────────────────────────

program
  .command('env')
  .description('Upload local .env file to the server')
  .option('--file <path>', 'Path to .env file to upload (default: .env from config)')
  .option('--no-reload', 'Upload without reloading running PM2 processes')
  .option('--app <name>', 'Target a specific app')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdEnv(process.cwd(), opts));

program
  .command('run [cmd...]')
  .description('Run a one-off command on the production server')
  .option('--tty', 'Force interactive TTY mode')
  .option('--app <name>', 'Target a specific app')
  .option('--config <path>', 'Use a specific config file')
  .action((cmdArgs: string[], opts) => cmdRun(process.cwd(), opts, cmdArgs));

// ── Process management ────────────────────────────────────────────

program
  .command('logs')
  .description('Show application logs')
  .option('--lines <n>', 'Number of log lines to show', '100')
  .option('--process <name>', 'Target a specific PM2 process')
  .option('--app <name>', 'Target a specific app')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdLogs(process.cwd(), { lines: parseInt(opts.lines, 10), process: opts.process, app: opts.app, config: opts.config }));

program
  .command('restart')
  .description('Restart the application')
  .option('--process <name>', 'Target a specific PM2 process')
  .option('--app <name>', 'Target a specific app')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdRestart(process.cwd(), opts));

program
  .command('stop')
  .description('Stop the application')
  .option('--process <name>', 'Target a specific PM2 process')
  .option('--app <name>', 'Target a specific app')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdStop(process.cwd(), opts));

program
  .command('metrics')
  .description('Open PM2 monitoring dashboard')
  .option('--app <name>', 'Target a specific app')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdMetrics(process.cwd(), opts));

program
  .command('monitor')
  .description('Live TUI dashboard with PM2 stats, system metrics, and logs')
  .option('--interval <seconds>', 'Polling interval in seconds (default: 2)', '2')
  .option('--app <name>', 'Target a specific app')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdMonitor(process.cwd(), opts));

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
  .option('--app <name>', 'Target a specific app')
  .option('--config <path>', 'Use a specific config file')
  .option('--environment <name>', 'GitHub Environment name', 'production')
  .option('--sync-env', 'Upload an environment-scoped dotenv secret before deploying')
  .action((opts) => cmdCiGithub(process.cwd(), opts));

ci.command('env-sync')
  .description('Sync a complete dotenv file to a GitHub Environment secret')
  .option('--all', 'Skip confirmation')
  .option('--app <name>', 'Target a specific app')
  .option('--config <path>', 'Use a specific config file')
  .option('--environment <name>', 'GitHub Environment name', 'production')
  .option('--file <path>', 'Path to the dotenv file (default: app envFile)')
  .option('--dry-run', 'Show the target without changing GitHub secrets')
  .action((opts) => cmdCiEnvSync(process.cwd(), opts));

// ── Config ────────────────────────────────────────────────────────

const config = program.command('config').description('Manage configuration');

config.command('show')
  .description('Show resolved configuration')
  .option('--app <name>', 'Show only a specific app (default: all)')
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

// ── Users ─────────────────────────────────────────────────────────

const user = program.command('user').description('Manage server users');

user.command('add <username>')
  .description('Add a user to .shipnode/users.yml and sync to server')
  .option('--key <path>', 'Public key file (default: ssh.identityFile + .pub)')
  .option('--sudo', 'Grant sudo privileges')
  .option('--no-sync', 'Only write to users.yml, do not sync to server')
  .option('--config <path>', 'Use a specific config file')
  .action((username: string, opts) => cmdUserAdd(process.cwd(), username, opts));

user.command('sync')
  .description('Sync users from .shipnode/users.yml to server')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdUserSync(process.cwd(), opts));

user.command('list')
  .description('List non-system users on server')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdUserList(process.cwd(), opts));

user.command('remove <username>')
  .description('Remove a user from the server')
  .option('--config <path>', 'Use a specific config file')
  .action((username: string, opts) => cmdUserRemove(process.cwd(), username, opts));

// ── Backup ────────────────────────────────────────────────────────

const backup = program.command('backup').description('Database & file backups to S3');

backup.command('setup')
  .description('Install backup script and systemd timer on server')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdBackupSetup(process.cwd(), opts));

backup.command('run')
  .description('Run a backup immediately')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdBackupRun(process.cwd(), opts));

backup.command('status')
  .description('Show backup timer and last run status')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdBackupStatus(process.cwd(), opts));

backup.command('list')
  .description('List recent backups in S3')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdBackupList(process.cwd(), opts));

backup.command('restore [snapshot]')
  .description('Restore a restic snapshot to a target directory (default: latest)')
  .option('--target <path>', 'Where to restore files (default: /tmp/shipnode-restore-<ts>)')
  .option('--tag <tag>', 'Filter by tag (db | files)')
  .option('--host <host>', 'Filter by hostname')
  .option('--config <path>', 'Use a specific config file')
  .action((snapshot: string | undefined, opts) => cmdBackupRestore(process.cwd(), snapshot, opts));

// ── Accessories ──────────────────────────────────────────────────

const accessory = program.command('accessory').description('Manage Docker accessories');

accessory.command('status [name]')
  .description('Show accessory container status')
  .option('--config <path>', 'Use a specific config file')
  .action((name: string | undefined, opts) => cmdAccessoryStatus(process.cwd(), { ...opts, name }));

accessory.command('logs <name>')
  .description('Show accessory logs')
  .option('--lines <n>', 'Number of log lines to show', '100')
  .option('--config <path>', 'Use a specific config file')
  .action((name: string, opts) => cmdAccessoryLogs(process.cwd(), name, { ...opts, lines: parseInt(opts.lines, 10) }));

accessory.command('restart <name>')
  .description('Restart an accessory')
  .option('--config <path>', 'Use a specific config file')
  .action((name: string, opts) => cmdAccessoryRestart(process.cwd(), name, opts));

accessory.command('stop <name>')
  .description('Stop an accessory')
  .option('--config <path>', 'Use a specific config file')
  .action((name: string, opts) => cmdAccessoryStop(process.cwd(), name, opts));

accessory.command('health <name>')
  .description('Run an accessory health check')
  .option('--config <path>', 'Use a specific config file')
  .action((name: string, opts) => cmdAccessoryHealth(process.cwd(), name, opts));

// ── Secrets / Registry ───────────────────────────────────────────

const secret = program.command('secret').description('Manage remote secrets');

secret.command('set <name> [value]')
  .description('Set a remote secret from an explicit value or local environment variable')
  .option('--on <target>', 'Server target name')
  .option('--config <path>', 'Use a specific config file')
  .action((name: string, value: string | undefined, opts) => cmdSecretSet(process.cwd(), name, value, opts));

const registry = program.command('registry').description('Manage Docker registry auth');

registry.command('login')
  .description('Store configured registry token on the target and run docker login')
  .option('--on <target>', 'Server target name')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdRegistryLogin(process.cwd(), opts));

// ── Cloudflare ────────────────────────────────────────────────────

const cloudflare = program.command('cloudflare').description('Cloudflare Tunnel integration');

cloudflare.command('init')
  .description('Install cloudflared and configure tunnel/DNS/Access')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdCloudflareInit(process.cwd(), opts));

cloudflare.command('audit')
  .description('Verify Cloudflare DNS and tunnel configuration')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdCloudflareAudit(process.cwd(), opts));

cloudflare.command('status')
  .description('Show cloudflared service and tunnel status')
  .option('--config <path>', 'Use a specific config file')
  .action((opts) => cmdCloudflareStatus(process.cwd(), opts));

// ── Self-update ───────────────────────────────────────────────────

program
  .command('upgrade')
  .description('Upgrade shipnode to the latest version')
  .action(() => cmdUpgrade());

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

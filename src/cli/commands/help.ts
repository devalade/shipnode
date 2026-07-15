import chalk from 'chalk';
import { ui } from '../ui.js';

export function cmdHelp(): void {
  ui.banner();
  console.log(`${chalk.bold.blue('ShipNode')} — Deploy Node.js apps to a single VPS

${chalk.bold('USAGE')}
  shipnode <command> [options]

${chalk.bold('CORE')}
  ${chalk.green('init')}              Initialize a new shipnode.config.ts
  ${chalk.green('setup')}             Setup a new server with required dependencies
  ${chalk.green('deploy')}            Deploy your application
  ${chalk.green('doctor')}            Check local and remote configuration
  ${chalk.green('status')}            Check application status

${chalk.bold('RELEASE MANAGEMENT')}
  ${chalk.green('rollback')}          Roll back to a previous release
  ${chalk.green('migrate')}           Migrate existing deploy to zero-downtime structure

${chalk.bold('ENVIRONMENT')}
  ${chalk.green('env')} [--file <p>]   Upload local .env file to the server
  ${chalk.green('run')} <cmd>         Run a one-off command on the production server

${chalk.bold('PROCESS MANAGEMENT')}
  ${chalk.green('logs')}              Show application logs
  ${chalk.green('restart')}           Restart the application
  ${chalk.green('stop')}              Stop the application
  ${chalk.green('metrics')}           Open PM2 monitoring dashboard
  ${chalk.green('monitor')}           Live TUI dashboard with stats and logs

${chalk.bold('SECURITY & MAINTENANCE')}
  ${chalk.green('harden')}            Apply server security hardening
  ${chalk.green('unlock')}            Clear a stuck deployment lock

${chalk.bold('USERS')}
  ${chalk.green('user sync')}         Sync .shipnode/users.yml to server
  ${chalk.green('user list')}         List non-system users on server
  ${chalk.green('user remove')} <u>   Remove a user from the server

${chalk.bold('BACKUP')}
  ${chalk.green('backup setup')}      Install backup script and systemd timer
  ${chalk.green('backup run')}        Run a backup immediately
  ${chalk.green('backup status')}     Show backup timer and last run
  ${chalk.green('backup list')}       List recent backups in S3

${chalk.bold('CLOUDFLARE')}
  ${chalk.green('cloudflare init')}   Install cloudflared, configure tunnel/DNS
  ${chalk.green('cloudflare audit')}  Verify DNS and tunnel configuration
  ${chalk.green('cloudflare status')} Show cloudflared service status

${chalk.bold('CI/CD')}
  ${chalk.green('ci github')}         Generate GitHub Actions deploy workflow
  ${chalk.green('ci env-sync')}       Sync one dotenv file to a GitHub Environment

${chalk.bold('CONFIGURATION')}
  ${chalk.green('config show')}       Show resolved configuration
  ${chalk.green('config validate')}   Validate configuration file
  ${chalk.green('config path')}       Print path to config file

${chalk.bold('CUSTOMIZATION')}
  ${chalk.green('eject')} [target]    Eject PM2/Caddy templates (pm2, caddy, all)
  ${chalk.green('upgrade')}           Upgrade shipnode to the latest version

${chalk.bold('OPTIONS')}
  --dry-run            Show what would be deployed (deploy only)
  --skip-build         Skip the build step (deploy only)
  --steps <n>          Releases to go back (rollback only)
  --lines <n>          Log lines to show (logs only, default: 100)
  --tty                Force interactive TTY (run only)
  --security           Run security audit (doctor only)
  --all                Skip confirmation (ci env-sync only)
  --environment <name> GitHub deployment environment (CI commands)
  --sync-env           Upload app env before CI deploy (ci github only)
  --config <path>      Use a specific config file

${chalk.bold('EXAMPLES')}
  ${chalk.dim('# First deploy')}
  shipnode init && shipnode setup && shipnode deploy

  ${chalk.dim('# Roll back one release')}
  shipnode rollback

  ${chalk.dim('# Run a database migration')}
  shipnode run "npx prisma migrate deploy"

  ${chalk.dim('# Open interactive shell on server')}
  shipnode run bash

  ${chalk.dim('# Push .env then restart')}
  shipnode env && shipnode restart

  ${chalk.dim('# Set up GitHub Actions CI')}
  shipnode ci github

  ${chalk.dim('# Opt in to GitHub-managed application env')}
  shipnode ci env-sync --app api --environment production --all
  shipnode ci github --app api --environment production --sync-env

  ${chalk.dim('# Harden server security')}
  shipnode harden

${chalk.bold('DOCUMENTATION')}
  https://github.com/devalade/shipnode
`);
}

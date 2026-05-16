import chalk from 'chalk';

export function cmdHelp(): void {
  console.log(`
${chalk.bold.blue('ShipNode')} v2.0.0 - Deploy Node.js apps to a single VPS

${chalk.bold('USAGE')}
  shipnode <command> [options]

${chalk.bold('COMMANDS')}
  ${chalk.green('init')}            Initialize a new shipnode.config.ts
  ${chalk.green('setup')}           Setup a new server with required dependencies
  ${chalk.green('deploy')}          Deploy your application
  ${chalk.green('doctor')}          Check local and remote configuration
  ${chalk.green('status')}          Check application status
  ${chalk.green('help')}            Show this help message

${chalk.bold('DEPLOY OPTIONS')}
  --dry-run          Show what would be deployed without making changes
  --skip-build       Skip the build step (use existing build output)
  --config <path>    Use a specific config file

${chalk.bold('INIT OPTIONS')}
  --non-interactive  Generate config without prompts
  --print            Print config to stdout without writing file

${chalk.bold('DOCTOR OPTIONS')}
  --security         Run security audit instead of standard checks

${chalk.bold('EXAMPLES')}
  ${chalk.dim('# Initialize a new project')}
  shipnode init

  ${chalk.dim('# Deploy with dry run first')}
  shipnode deploy --dry-run

  ${chalk.dim('# Deploy to production')}
  shipnode deploy

  ${chalk.dim('# Check server health')}
  shipnode doctor

  ${chalk.dim('# Run security audit')}
  shipnode doctor --security

${chalk.bold('DOCUMENTATION')}
  https://github.com/devalade/shipnode
`);
}

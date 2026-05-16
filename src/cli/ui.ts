import chalk from 'chalk';

export const ui = {
  info(msg: string) {
    console.log(`${chalk.blue('→')} ${msg}`);
  },
  success(msg: string) {
    console.log(`${chalk.green('✓')} ${msg}`);
  },
  warn(msg: string) {
    console.log(`${chalk.yellow('⚠')} ${msg}`);
  },
  error(msg: string) {
    console.error(`${chalk.red('Error:')} ${msg}`);
  },
  heading(msg: string) {
    console.log(`\n${chalk.blue.bold(msg)}\n`);
  },
  section(title: string, items: [string, string][]): void {
    console.log(chalk.bold(title));
    for (const [key, value] of items) {
      console.log(`  ${chalk.dim(key.padEnd(20))} ${value}`);
    }
    console.log();
  },
};

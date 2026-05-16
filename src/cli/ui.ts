import chalk from 'chalk';
import * as clack from '@clack/prompts';

export { clack };

export const ui = {
  banner(version?: string): void {
    const v = version ? chalk.dim(` v${version}`) : '';
    clack.intro(`${chalk.bold.cyan('⚓ ShipNode')}${v}`);
  },

  outro(msg: string): void {
    clack.outro(msg);
  },

  info(msg: string): void {
    clack.log.info(msg);
  },

  success(msg: string): void {
    clack.log.success(msg);
  },

  warn(msg: string): void {
    clack.log.warn(msg);
  },

  error(msg: string): void {
    clack.log.error(msg);
  },

  step(msg: string): void {
    clack.log.step(msg);
  },

  note(msg: string, title?: string): void {
    clack.note(msg, title);
  },

  spinner() {
    return clack.spinner();
  },

  heading(msg: string): void {
    clack.log.step(chalk.bold(msg));
  },

  section(title: string, items: [string, string][]): void {
    const rows = items.map(([k, v]) => `${chalk.dim(k.padEnd(18))} ${v}`).join('\n');
    clack.note(rows, title);
  },
};

import chalk from 'chalk';
import { RemoteExecutor } from '../../domain/remote/executor.js';
import type { ExecResult } from '../../shared/types.js';

export class LoggingExecutor extends RemoteExecutor {
  constructor(private inner: RemoteExecutor) { super(); }

  async exec(command: string, options?: { timeout?: number }): Promise<ExecResult> {
    const result = await this.inner.exec(command, options);
    if (result.stdout) {
      for (const line of result.stdout.split('\n')) {
        if (line.trim()) process.stdout.write(chalk.dim('  remote: ' + line) + '\n');
      }
    }
    if (result.stderr) {
      for (const line of result.stderr.split('\n')) {
        if (line.trim()) process.stderr.write(chalk.yellow('  remote: ' + line) + '\n');
      }
    }
    return result;
  }
}

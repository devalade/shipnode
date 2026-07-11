import { Result, type Result as ResultType } from 'better-result';
import type { RemoteExecutor } from '../../domain/remote/executor.js';
import { ProcessRestartError } from '../../shared/result-errors.js';
import { MISE, shellQuote } from './poller.js';

/**
 * Restart exactly one PM2 process by its full pm2 name — never a bare
 * namespace, so a single keypress cannot bounce a whole deployment.
 */
export async function restartProcess(
  executor: RemoteExecutor,
  pm2Name: string,
): Promise<ResultType<void, ProcessRestartError>> {
  const result = await executor.exec(
    `${MISE} && pm2 restart ${shellQuote(pm2Name)} --update-env`,
  );
  if (result.exitCode !== 0) {
    return Result.err(new ProcessRestartError({
      pm2Name,
      detail: (result.stderr || result.stdout).trim() || `exit code ${result.exitCode}`,
    }));
  }
  return Result.ok(undefined);
}

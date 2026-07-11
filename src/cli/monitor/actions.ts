import { Result, type Result as ResultType } from 'better-result';
import type { RemoteExecutor } from '../../domain/remote/executor.js';
import type { ShipnodeApp, ShipnodeConfig } from '../../shared/types.js';
import { ProcessRestartError, ReleaseRollbackError } from '../../shared/result-errors.js';
import { getEcosystemPath } from '../../domain/pm2/apps.js';
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

/**
 * Switch the app's `current` symlink to an existing release and, for backend
 * apps, reload PM2 from that release's ecosystem file (same recovery path as
 * `shipnode rollback`, minus the interactive prompt — the TUI confirms first).
 */
export async function rollbackToRelease(
  executor: RemoteExecutor,
  config: ShipnodeConfig,
  app: ShipnodeApp,
  timestamp: string,
): Promise<ResultType<void, ReleaseRollbackError>> {
  const fail = (detail: string): ResultType<void, ReleaseRollbackError> =>
    Result.err(new ReleaseRollbackError({ appName: app.name, timestamp, detail }));

  const appPath = `${config.remotePath}/${app.name}`;
  const releasePath = `${appPath}/releases/${timestamp}`;

  const exists = await executor.exec(`[ -d ${shellQuote(releasePath)} ]`);
  if (exists.exitCode !== 0) return fail('release directory not found on server');

  const switched = await executor.exec(
    `ln -sfn ${shellQuote(releasePath)} ${shellQuote(`${appPath}/current.tmp`)} && ` +
    `mv -Tf ${shellQuote(`${appPath}/current.tmp`)} ${shellQuote(`${appPath}/current`)}`,
  );
  if (switched.exitCode !== 0) {
    return fail((switched.stderr || switched.stdout).trim() || 'failed to switch current symlink');
  }

  const namespace = app.pm2?.apps[0]?.name;
  if (app.appType === 'backend' && namespace !== undefined) {
    const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
    const ecosystem = getEcosystemPath(config, app.name);
    // Prefer the rolled-back release's ecosystem file (ADR-0001); fall back to
    // a namespace reload for releases that predate per-release ecosystem files.
    const reloaded = await executor.exec(
      `${MISE}; mise exec node@${nodeVersion} -- ` +
      `sh -c ${shellQuote(`pm2 reload "${ecosystem}" --update-env 2>/dev/null || pm2 reload ${namespace} --update-env`)}`,
    );
    if (reloaded.exitCode !== 0) {
      return fail(
        `symlink switched but PM2 reload failed: ${(reloaded.stderr || reloaded.stdout).trim() || `exit code ${reloaded.exitCode}`}`,
      );
    }
  }

  return Result.ok(undefined);
}

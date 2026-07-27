import chalk from 'chalk';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import type { ShipnodeConfig, ShipnodeApp } from '../../shared/types.js';
import { SshConnection } from '../../infrastructure/ssh/connection.js';
import { LoggingExecutor } from '../../infrastructure/ssh/logging-executor.js';
import { DeployService } from '../../services/deploy.service.js';
import { HealthCheckService } from '../../services/health.service.js';
import { DeployLock } from '../../domain/release/manager.js';
import { HotSync, type BuildLocation, type HotSyncResult } from '../../domain/deploy/hot-sync.js';
import { parseIgnoreFileDirs, watchProject, type ProjectWatcher } from '../../domain/deploy/watcher.js';
import { LockError } from '../../shared/errors.js';
import { ui } from '../ui.js';

/**
 * `shipnode deploy --watch` — the development loop.
 *
 * One full deploy establishes a coherent baseline (dependencies installed,
 * release health-checked, Caddy wired), then every local edit is rsynced into
 * that live release and the processes are reloaded. The first deploy is the
 * slow one; each edit after it is a hot sync.
 *
 * The session owns three things the hot sync itself does not: the deploy lock
 * (so a concurrent `shipnode deploy` can never interleave with a sync),
 * serialisation of cycles (edits arriving mid-sync are coalesced into the next
 * one), and reconnecting an SSH session that dropped while idle.
 */
export async function runDeployWatch(
  cwd: string,
  config: ShipnodeConfig,
  app: ShipnodeApp,
  options: { buildLocation: BuildLocation },
): Promise<void> {
  const ssh = new SshConnection();
  await ssh.connect(config.ssh);

  const executor = new LoggingExecutor(ssh);
  const lock = new DeployLock(ssh, config.remotePath);

  let watcher: ProjectWatcher | undefined;

  const hotSync = new HotSync(
    config,
    app,
    executor,
    cwd,
    new HealthCheckService(executor, config),
    {
      buildLocation: options.buildLocation,
      // Deliberately late-bound: the watcher is created after the baseline
      // deploy, but the build that deploy runs must be suppressed too.
      suppressWatch: {
        pause: () => watcher?.pause(),
        resume: () => watcher?.resume(),
      },
    },
  );

  let stopping = false;
  let lockHeld = false;

  /**
   * Release the deploy lock before exiting.
   *
   * Ctrl-C lands while a cycle may be holding the lock, and exiting there
   * would skip the `finally` that releases it — leaving a lock no process
   * owns, which blocks every later deploy until someone runs `shipnode
   * unlock`. A second Ctrl-C bypasses this and exits immediately, so a wedged
   * release can never trap the user.
   */
  const shutdown = (): void => {
    if (stopping) {
      process.exit(130);
    }
    stopping = true;
    watcher?.close();

    const finish = (): never => {
      ssh.disconnect();
      ui.outro('Watch stopped.');
      process.exit(0);
    };

    if (!lockHeld) finish();

    process.stdout.write(chalk.dim('  releasing deploy lock…\n'));
    const timeout = setTimeout(() => {
      ui.warn('Could not release the deploy lock. Run `shipnode unlock` before the next deploy.');
      finish();
    }, 5000);

    void lock
      .release()
      .catch(() => {
        ui.warn('Could not release the deploy lock. Run `shipnode unlock` before the next deploy.');
      })
      .finally(() => {
        clearTimeout(timeout);
        finish();
      });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    ui.banner();
    ui.step(`Watching ${chalk.bold(app.name)} → ${config.ssh.user}@${config.ssh.host}`);
    ui.warn(
      'Watch mode patches the release that is serving traffic — no new release, ' +
      'no rollback target, and reload can drop in-flight requests. Use plain ' +
      '`shipnode deploy` for anything you need to be able to roll back.',
    );

    // The baseline deploy runs with skipBuild for local/none, so a local build
    // has to happen here or the first release ships stale build output.
    if (options.buildLocation === 'local') {
      ui.step('Building locally…');
      await hotSync.buildLocally();
    }

    ui.step(`Initial deploy… ${chalk.dim(`(build: ${options.buildLocation})`)}`);
    // The baseline deploy builds on the server only when the loop will too.
    await new DeployService(executor, config).execute(cwd, options.buildLocation !== 'remote');

    let busy = false;
    const pending = new Set<string>();

    const drain = async (): Promise<void> => {
      busy = true;
      try {
        while (pending.size > 0 && !stopping) {
          const batch = [...pending];
          pending.clear();
          await runCycle(batch);
        }
      } finally {
        busy = false;
      }
    };

    const runCycle = async (batch: string[]): Promise<void> => {
      const label = batch.length === 1 ? batch[0] : `${batch.length} files`;
      process.stdout.write(`${chalk.dim('│')} ${chalk.cyan('⟳')} ${label}\n`);

      try {
        await withLock(lock, async () => {
          lockHeld = true;
          const result = await syncWithReconnect(ssh, config, hotSync, batch);
          reportCycle(result);
        }, () => {
          lockHeld = false;
        });
      } catch (error) {
        if (error instanceof LockError) {
          process.stdout.write(
            `${chalk.dim('│')} ${chalk.yellow('⏸')} another deploy holds the lock — skipped\n`,
          );
          return;
        }
        // A failed sync is expected during development (a type error, a crashed
        // boot). Report it and keep watching; the next save retries.
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`${chalk.dim('│')} ${chalk.red('✗')} ${message}\n`);
      }
    };

    watcher = watchProject(cwd, {
      // Watch build output only when nothing in this process writes it — that
      // is, when the developer or their framework owns the build (`none`).
      // Under `local` *we* run the build, so watching its output would feed
      // our own writes back in as changes and rebuild forever. Watching is not
      // the same as syncing: `local` still ships the artifact, via a full-tree
      // rsync that detects it without the watcher's help.
      watchBuildOutput: options.buildLocation === 'none',
      ignoredDirs: await readIgnoredDirs(cwd),
      onBatch: (paths) => {
        for (const path of paths) pending.add(path);
        if (!busy) void drain();
      },
      onError: (error) => ui.warn(`watcher: ${error.message}`),
    });

    ui.success(
      `Ready — editing files in ${cwd} syncs to the live release` +
      (watcher.mode === 'poll' ? chalk.dim(' (polling: recursive fs.watch unavailable)') : ''),
    );
    process.stdout.write(chalk.dim('  Ctrl-C to stop.\n'));

    // Hold the process open; the watcher drives everything from here.
    await new Promise<never>(() => {});
  } catch (error) {
    watcher?.close();
    ssh.disconnect();
    throw error;
  }
}

/**
 * Directory names from `.shipnodeignore`, so the watcher does not wake up for
 * paths rsync would refuse to transfer anyway.
 */
async function readIgnoredDirs(cwd: string): Promise<string[]> {
  try {
    return parseIgnoreFileDirs(await readFile(resolve(cwd, '.shipnodeignore'), 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Acquire the deploy lock, run `body`, and always release it.
 *
 * `onReleased` runs after the lock is gone so the caller can stop tracking it —
 * the signal handler uses that to know whether it still has a lock to clean up.
 */
async function withLock(
  lock: DeployLock,
  body: () => Promise<void>,
  onReleased: () => void = () => {},
): Promise<void> {
  await lock.acquire();
  try {
    await body();
  } finally {
    await lock.release();
    onReleased();
  }
}

/**
 * Run a hot sync, reconnecting once if the SSH session died while idle.
 *
 * A watch session sits idle for long stretches; even with keepalives a laptop
 * suspend or a NAT timeout can drop the connection. Reconnecting beats making
 * the user restart the session.
 */
async function syncWithReconnect(
  ssh: SshConnection,
  config: ShipnodeConfig,
  hotSync: HotSync,
  batch: string[],
): Promise<HotSyncResult> {
  if (!ssh.isConnected()) {
    process.stdout.write(`${chalk.dim('│')} ${chalk.yellow('⟲')} reconnecting…\n`);
    await ssh.connect(config.ssh);
  }

  try {
    return await hotSync.run(batch);
  } catch (error) {
    if (ssh.isConnected()) throw error;
    process.stdout.write(`${chalk.dim('│')} ${chalk.yellow('⟲')} connection lost — reconnecting…\n`);
    await ssh.connect(config.ssh);
    return hotSync.run(batch);
  }
}

function reportCycle(result: HotSyncResult): void {
  const parts: string[] = [
    `${result.transferredFiles} file${result.transferredFiles === 1 ? '' : 's'}`,
  ];
  if (result.mode === 'full') parts.push('full scan');
  if (result.installed) parts.push('installed');
  if (result.built) parts.push('built');
  if (result.reloaded) parts.push('reloaded');

  const seconds = (result.durationMs / 1000).toFixed(2);
  const health =
    result.health === 'passed'
      ? chalk.green('healthy')
      : result.health === 'failed'
        ? chalk.red('unhealthy')
        : chalk.dim('no health check');

  process.stdout.write(
    `${chalk.dim('│')} ${chalk.green('✓')} ${parts.join(', ')} · ${health} · ${chalk.bold(`${seconds}s`)}\n`,
  );

  if (result.health === 'failed' && result.healthError) {
    process.stdout.write(`${chalk.dim('│')}   ${chalk.dim(result.healthError.split('\n')[0])}\n`);
  }
}

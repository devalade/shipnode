import chalk from 'chalk';
import type { ShipnodeConfig, ShipnodeApp, ExecResult } from '../../shared/types.js';
import { getActiveApp } from '../workspace.js';
import type { RemoteExecutor } from '../remote/executor.js';
import { ReleaseManager, DeployLock } from '../release/manager.js';
import { HealthCheckService } from '../../services/health.service.js';
import { CaddyService } from '../../services/caddy.service.js';
import { DeployError } from '../../shared/errors.js';
import type { DeploymentStrategy, StrategyContext } from './strategy.js';

/**
 * The release orchestrator owns the invariant deployment sequence.
 *
 * It knows nothing about app-specific details (those live in the
 * DeploymentStrategy). It knows everything about lock management,
 * release directories, symlinks, health checks, hooks, and cleanup.
 *
 * This is a deep module: a small interface (`deploy`) hides a lot of
 * behaviour (the full zero-downtime or legacy lifecycle).
 */
export class DeployOrchestrator {
  constructor(
    private config: ShipnodeConfig,
    private executor: RemoteExecutor,
    private releases: ReleaseManager,
    private lock: DeployLock,
    private healthCheck: HealthCheckService,
    private caddy: CaddyService,
  ) {}

  private get app(): ShipnodeApp {
    return getActiveApp(this.config);
  }

  async deploy(
    strategy: DeploymentStrategy,
    options: { cwd: string; skipBuild: boolean; gitCommit?: string },
  ): Promise<void> {
    await this.deployRelease(strategy, options);
  }

  private async deployRelease(
    strategy: DeploymentStrategy,
    options: { cwd: string; skipBuild: boolean; gitCommit?: string },
  ): Promise<void> {
    const deployStart = Date.now();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    await this.lock.acquire();

    try {
      const releasePath = await this.releases.createReleasePath(timestamp);
      await this.releases.setupReleaseStructure();

      const ctx: StrategyContext = {
        config: this.config,
        executor: this.executor,
        workDir: releasePath,
        cwd: options.cwd,
        skipBuild: options.skipBuild,
      };

      await strategy.stage(ctx);

      if (strategy.setupEnvironment) {
        await strategy.setupEnvironment(ctx);
      }

      await this.runHook('preDeploy', releasePath);
      await this.releases.switchSymlink(releasePath);

      if (strategy.startApp) {
        const startCtx: StrategyContext = {
          ...ctx,
          workDir: `${this.config.remotePath}/current`,
        };
        await strategy.startApp(startCtx);
      }

      let healthAttempts: number | undefined;
      let healthResponseMs: number | undefined;

      if (this.app.appType === 'backend' && this.app.healthCheck.enabled) {
        const healthResult = await this.healthCheck.perform();
        healthAttempts = healthResult.attempts;
        healthResponseMs = healthResult.responseMs;
      }

      const duration = Math.round((Date.now() - deployStart) / 1000);

      await this.releases.recordRelease({
        timestamp,
        status: 'success',
        duration,
        gitCommit: options.gitCommit,
        healthAttempts,
        healthResponseMs,
      });

      await this.runHook('postDeploy', releasePath);
      await this.releases.cleanupOldReleases();

      if (this.app.domain) {
        if (this.app.appType === 'backend') {
          await this.caddy.configureBackend();
        } else {
          await this.caddy.configureFrontend();
        }
      }
    } catch (error) {
      await this.lock.release();
      throw error;
    }

    await this.lock.release();
  }

  private async runHook(hookName: 'preDeploy' | 'postDeploy', workDir: string): Promise<void> {
    const hook = this.app.hooks?.[hookName];
    if (!hook) return;

    const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
    // When appRoot is set, run hook commands from inside the app subdir so
    // relative paths in user commands (`node build/ace.js`, `pnpm exec ...`)
    // resolve against the app, not the workspace root.
    const hookCwd = this.app.appRoot ? `${workDir}/${this.app.appRoot}` : workDir;
    // Source `.env` via absolute workDir path so it works regardless of
    // hookCwd. The file is symlinked into workDir during setupEnvironment;
    // PM2 will load the same vars at startup, so hooks and the app agree on
    // their environment. No-op when the project declares no envFile.
    const envSource = this.app.envFile
      ? `set -a && . "${workDir}/.env" && set +a && `
      : '';
    const prefix = chalk.dim('  │ ');

    const onData = (chunk: string): void => {
      chunk.split('\n').forEach((line) => {
        if (line.trim()) process.stdout.write(prefix + line + '\n');
      });
    };

    const ctx = {
      config: this.config,
      env: 'production',
      exec: async (cmd: string): Promise<ExecResult> => {
        const result = await this.executor.exec(
          `cd "${hookCwd}" && ${mise} && ${envSource}${cmd}`,
          { onData },
        );
        if (result.exitCode !== 0) {
          throw new Error(result.stderr || result.stdout || `Command failed: ${cmd}`);
        }
        return result;
      },
    };

    try {
      await hook(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DeployError(`${hookName} hook failed: ${message}`, hookName);
    }
  }
}

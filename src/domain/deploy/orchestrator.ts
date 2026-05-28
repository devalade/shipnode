import chalk from 'chalk';
import type { ShipnodeConfig, ExecResult } from '../../shared/types.js';
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

      if (this.config.app === 'backend' && this.config.healthCheck.enabled) {
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

      if (this.config.domain) {
        if (this.config.app === 'backend') {
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
    const hook = this.config.hooks?.[hookName];
    if (!hook) return;

    const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
    // Source `.env` (symlinked into workDir during setupEnvironment) so hook
    // commands like `node ace.js migration:run` see the same env vars that
    // PM2 will load at startup. Without this, framework CLIs (AdonisJS,
    // NestJS) re-validate env from the build dir and crash on missing vars.
    // No-op when the project declares no envFile.
    const envSource = this.config.envFile ? `set -a && . ./.env && set +a && ` : '';
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
          `cd "${workDir}" && ${mise} && ${envSource}${cmd}`,
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

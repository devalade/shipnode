import chalk from 'chalk';
import type { ShipnodeConfig, ShipnodeApp, ExecResult } from '../../shared/types.js';
import type { RemoteExecutor } from '../remote/executor.js';
import { ReleaseManager, DeployLock } from '../release/manager.js';
import { HealthCheckService } from '../../services/health.service.js';
import { CaddyService } from '../../services/caddy.service.js';
import { DeployError } from '../../shared/errors.js';
import type { DeploymentStrategy, StrategyContext } from './strategy.js';
import { BackendStrategy } from './backend-strategy.js';
import { FrontendStrategy } from './frontend-strategy.js';

export class DeployOrchestrator {
  constructor(
    private config: ShipnodeConfig,
    private executor: RemoteExecutor,
    private lock: DeployLock,
    private healthCheck: HealthCheckService,
    private caddy: CaddyService,
  ) {}

  async deploy(options: { cwd: string; skipBuild: boolean; gitCommit?: string }): Promise<void> {
    const cwd = options.cwd;

    await this.lock.acquire();

    try {
      for (const app of this.config.apps) {
        console.log(chalk.cyan(`\n── ${chalk.bold(app.name)} (${app.appType}) ──\n`));
        const strategy = this.createStrategy(app, cwd);
        await this.deployApp(app, strategy, options);
      }

      await this.caddy.configureAll();
    } catch (error) {
      await this.lock.release();
      throw error;
    }

    await this.lock.release();
  }

  private createStrategy(app: ShipnodeApp, cwd: string): DeploymentStrategy {
    if (app.appType === 'backend') {
      return new BackendStrategy(this.config, app, cwd);
    }
    return new FrontendStrategy(this.config, app, cwd);
  }

  private async deployApp(
    app: ShipnodeApp,
    strategy: DeploymentStrategy,
    options: { cwd: string; skipBuild: boolean; gitCommit?: string },
  ): Promise<void> {
    const deployStart = Date.now();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const appPath = `${this.config.remotePath}/${app.name}`;
    const releases = new ReleaseManager(this.executor, appPath, app.keepReleases);

    try {
      const releasePath = await releases.createReleasePath(timestamp);
      await releases.setupReleaseStructure();

      const ctx: StrategyContext = {
        config: this.config,
        app,
        executor: this.executor,
        workDir: releasePath,
        cwd: options.cwd,
        skipBuild: options.skipBuild,
      };

      await strategy.stage(ctx);

      if (strategy.setupEnvironment) {
        await strategy.setupEnvironment(ctx);
      }

      await this.runHook(app, 'preDeploy', releasePath);
      await releases.switchSymlink(releasePath);

      if (strategy.startApp) {
        const startCtx: StrategyContext = {
          ...ctx,
          workDir: `${appPath}/current`,
        };
        await strategy.startApp(startCtx);
      }

      let healthAttempts: number | undefined;
      let healthResponseMs: number | undefined;

      if (app.appType === 'backend' && app.healthCheck.enabled) {
        const healthResult = await this.healthCheck.perform(app);
        healthAttempts = healthResult.attempts;
        healthResponseMs = healthResult.responseMs;
      }

      const duration = Math.round((Date.now() - deployStart) / 1000);

      await releases.recordRelease({
        timestamp,
        status: 'success',
        duration,
        gitCommit: options.gitCommit,
        healthAttempts,
        healthResponseMs,
      });

      await this.runHook(app, 'postDeploy', releasePath);
      await releases.cleanupOldReleases();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DeployError(`[${app.name}] ${message}`, 'deploy');
    }
  }

  private async runHook(
    app: ShipnodeApp,
    hookName: 'preDeploy' | 'postDeploy',
    workDir: string,
  ): Promise<void> {
    const hook = app.hooks?.[hookName];
    if (!hook) return;

    const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
    const hookCwd = app.appRoot ? `${workDir}/${app.appRoot}` : workDir;
    const envSource = app.envFile
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

import chalk from 'chalk';
import type { ShipnodeConfig, ShipnodeApp, Pm2App, ExecResult } from '../../shared/types.js';
import type { RemoteExecutor } from '../remote/executor.js';
import { ReleaseManager, DeployLock } from '../release/manager.js';
import { HealthCheckService } from '../../services/health.service.js';
import { CaddyService } from '../../services/caddy.service.js';
import { AccessoryService } from '../../services/accessory.service.js';
import { DeployError } from '../../shared/errors.js';
import { getPm2Name } from '../pm2/apps.js';
import {
  readDeployState,
  writeDeployState,
  resolveTarget,
  resolveAltPort,
  coloredWebName,
  type DeployTarget,
} from './blue-green.js';
import type { DeploymentStrategy, StrategyContext } from './strategy.js';
import { BackendStrategy } from './backend-strategy.js';
import { FrontendStrategy } from './frontend-strategy.js';
import { runWithDotenv } from './dotenv.js';

/** Release directory name: an ISO timestamp with the characters paths dislike removed. */
export function newReleaseId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * What this replica is responsible for beyond deploying itself.
 *
 * `first`/`last` are positions in *this roll*: `beforeFleet` fires on the first
 * replica and `afterFleet` on the last, so a migration runs once for the roll
 * rather than once per server.
 *
 * `primary` is a property of the *server*, not the roll — it is the first server
 * the app is declared on, whatever `--on` narrowed this run to. `placement:
 * 'primary'` processes start only there, so re-deploying a single replica can
 * never bring up a second copy of a scheduler.
 *
 * All three default to true: a single-server deploy is the whole fleet.
 */
export interface ReplicaRole {
  first: boolean;
  last: boolean;
  primary: boolean;
}

const SOLE_REPLICA: ReplicaRole = { first: true, last: true, primary: true };

export class DeployOrchestrator {
  constructor(
    private config: ShipnodeConfig,
    private executor: RemoteExecutor,
    private lock: DeployLock,
    private healthCheck: HealthCheckService,
    private caddy: CaddyService,
    private accessories?: AccessoryService,
  ) {}

  /**
   * `releaseId` lets a fleet deploy give every replica the same release
   * directory name. Without it each replica mints its own timestamp and there
   * is no way to tell a converged fleet from a half-rolled one.
   */
  async deploy(options: {
    cwd: string;
    skipBuild: boolean;
    gitCommit?: string;
    releaseId?: string;
    fleetRole?: ReplicaRole;
  }): Promise<void> {
    const cwd = options.cwd;

    await this.lock.acquire();

    try {
      await this.accessories?.ensureAll();

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
    options: { cwd: string; skipBuild: boolean; gitCommit?: string; releaseId?: string; fleetRole?: ReplicaRole },
  ): Promise<void> {
    const fleetRole = options.fleetRole ?? SOLE_REPLICA;
    const deployStart = Date.now();
    const timestamp = options.releaseId ?? newReleaseId();
    const appPath = `${this.config.remotePath}/${app.name}`;
    const releases = new ReleaseManager(this.executor, appPath, app.keepReleases);

    let previousReleasePath: string | null = null;
    let symlinkSwitched = false;
    let trafficSwitched = false;

    try {
      previousReleasePath = await releases.getCurrentReleasePath();
      const releasePath = await releases.createReleasePath(timestamp);
      await releases.setupReleaseStructure();

      const ctx: StrategyContext = {
        config: this.config,
        app,
        executor: this.executor,
        workDir: releasePath,
        cwd: options.cwd,
        skipBuild: options.skipBuild,
        primaryReplica: fleetRole.primary,
      };

      await strategy.stage(ctx);

      if (strategy.setupEnvironment) {
        await strategy.setupEnvironment(ctx);
      }

      // Fleet-wide work first: the new release is staged everywhere it needs to
      // be readable from, but nothing is live yet, so a migration here runs
      // against the old code still serving traffic — the expand half of
      // expand/contract.
      if (fleetRole.first) await this.runHook(app, 'beforeFleet', releasePath);
      await this.runHook(app, 'preDeploy', releasePath);
      await releases.switchSymlink(releasePath);
      symlinkSwitched = true;

      // Blue-green: resolve which colour/port this release targets before we
      // start it. The old colour keeps serving until the flip below.
      const target = await this.resolveDeployTarget(app, appPath);

      const startCtx: StrategyContext = {
        ...ctx,
        workDir: `${appPath}/current`,
        deployTarget: target,
      };

      if (strategy.startApp) {
        await strategy.startApp(startCtx);
      }

      let healthAttempts: number | undefined;
      let healthResponseMs: number | undefined;

      if (app.appType === 'backend' && app.healthCheck.enabled) {
        const healthResult = await this.healthCheck.perform(
          app,
          this.healthOpts(app, target, fleetRole.primary),
        );
        healthAttempts = healthResult.attempts;
        healthResponseMs = healthResult.responseMs;
      }

      // Health passed — reload workers (blue-green) before flipping traffic so a
      // worker failure still leaves Caddy on the old colour.
      if (strategy.afterHealthy) {
        await strategy.afterHealthy(startCtx);
      }

      // Flip Caddy's upstream to the new colour and persist the active colour.
      // A failed health check throws before this, leaving the old colour serving
      // and Caddy untouched (zero user impact).
      if (target) {
        await this.caddy.configureBackend(app, target.port);
        await this.caddy.reload();
        trafficSwitched = true;
        await writeDeployState(this.executor, appPath, {
          activeColor: target.color,
          bluePort: target.bluePort,
          greenPort: target.greenPort,
        });
        if (strategy.afterTrafficSwitch) {
          await strategy.afterTrafficSwitch(startCtx);
        }
        console.log(chalk.dim(`  blue-green: traffic now on ${target.color} (port ${target.port})`));
      }

      const duration = Math.round((Date.now() - deployStart) / 1000);

      await releases.recordRelease({
        timestamp,
        status: 'success',
        duration,
        gitCommit: options.gitCommit,
        healthAttempts,
        healthResponseMs,
        previousRelease: previousReleasePath
          ? previousReleasePath.split('/').pop()
          : undefined,
      });

      await this.runHook(app, 'postDeploy', releasePath);
      // The roll reached its final replica, so every server is now on this
      // release. Safe to drop what the old code needed — the contract half.
      if (fleetRole.last) await this.runHook(app, 'afterFleet', releasePath);
      await releases.cleanupOldReleases();
    } catch (error) {
      const duration = Math.round((Date.now() - deployStart) / 1000);
      const message = error instanceof Error ? error.message : String(error);

      if (symlinkSwitched && previousReleasePath && !trafficSwitched) {
        try {
          await releases.switchSymlink(previousReleasePath);
          console.log(chalk.dim(`  reverted current → ${previousReleasePath.split('/').pop()}`));
        } catch {
          // Best-effort — still record the failure below.
        }
      }

      try {
        await releases.recordRelease({
          timestamp,
          status: 'failed',
          duration,
          gitCommit: options.gitCommit,
          previousRelease: previousReleasePath
            ? previousReleasePath.split('/').pop()
            : undefined,
        });
      } catch {
        // Best-effort audit trail.
      }

      throw new DeployError(`[${app.name}] ${message}`, 'deploy');
    }
  }

  /**
   * Resolve the blue-green target for a backend web app with zeroDowntime, or
   * undefined for the default recreate path. Reads the persisted colour/port
   * state from the host.
   */
  private async resolveDeployTarget(app: ShipnodeApp, appPath: string): Promise<DeployTarget | undefined> {
    if (app.appType !== 'backend' || !app.zeroDowntime) return undefined;
    const webApp = app.pm2?.apps.find((pm2App) => pm2App.port !== undefined);
    if (!webApp?.port) return undefined;

    const state = await readDeployState(this.executor, appPath);
    const altPort = resolveAltPort(webApp.port, app.altPort);
    const target = resolveTarget(state, webApp.port, altPort);
    console.log(chalk.dim(`  blue-green: booting ${target.color} on port ${target.port}`));
    return target;
  }

  /**
   * Health-check options that point the probe at the blue-green target colour
   * (its port and colour-suffixed pm2 name) instead of the static config.
   *
   * `primaryReplica` also narrows which processes must be online. The status
   * check requires every declared pm2 app to be running, and a `placement:
   * 'primary'` process is deliberately absent from every other replica — so
   * without this, placement working correctly is what fails the health check.
   */
  private healthOpts(
    app: ShipnodeApp,
    target: DeployTarget | undefined,
    primaryReplica: boolean,
  ): { httpPort?: number; resolvePm2Name?: (a: Pm2App) => string; pm2Apps?: Pm2App[] } | undefined {
    if (!target) {
      const declared = app.pm2?.apps ?? [];
      const placed = declared.filter((a) => primaryReplica || a.placement !== 'primary');
      // Only override when placement actually removed something, so the default
      // path stays byte-identical for every config that does not use it.
      return placed.length === declared.length ? undefined : { pm2Apps: placed };
    }
    const namespace = app.pm2?.apps[0]?.name ?? app.name;
    // Workers are still on the previous release until afterHealthy — only the
    // new web colour must be online for this probe.
    const webApps = (app.pm2?.apps ?? []).filter((a) => a.port !== undefined);
    return {
      httpPort: target.port,
      pm2Apps: webApps,
      resolvePm2Name: (a: Pm2App) =>
        a.port !== undefined
          ? coloredWebName(namespace, a.name, target.color)
          : getPm2Name(namespace, a.name),
    };
  }

  private async runHook(
    app: ShipnodeApp,
    hookName: keyof NonNullable<ShipnodeApp['hooks']>,
    workDir: string,
  ): Promise<void> {
    const hook = app.hooks?.[hookName];
    if (!hook) return;

    const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
    const hookCwd = app.appRoot ? `${workDir}/${app.appRoot}` : workDir;
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
          `cd "${hookCwd}" && ${mise} && ${runWithDotenv(app.envFile ? `${workDir}/.env` : undefined, cmd)}`,
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

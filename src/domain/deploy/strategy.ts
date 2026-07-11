import type { RemoteExecutor } from '../remote/executor.js';

/**
 * Context passed to every deployment strategy method.
 */
export interface StrategyContext {
  config: import('../../shared/types.js').ShipnodeConfig;
  app: import('../../shared/types.js').ShipnodeApp;
  executor: RemoteExecutor;
  workDir: string;
  cwd: string;
  skipBuild: boolean;
  /**
   * Blue-green target for this deploy, resolved by the orchestrator before
   * `startApp` when the app has `zeroDowntime` enabled. Absent for the default
   * recreate path.
   */
  deployTarget?: import('./blue-green.js').DeployTarget;
}

/**
 * A deployment strategy knows how to stage, prepare, and start
 * a specific kind of application (backend, frontend, etc.).
 *
 * Strategies are adapters at the deployment seam. The orchestrator
 * owns the invariant lifecycle; the strategy owns the app-specific
 * details.
 */
export interface DeploymentStrategy {
  readonly name: string;

  /**
   * Stage artifacts onto the remote host.
   *
   * For a backend this usually means rsyncing source files.
   * For a frontend this means building locally and rsyncing build output.
   */
  stage(ctx: StrategyContext): Promise<void>;

  /**
   * Prepare the runtime environment on the remote host.
   *
   * Optional. For backends this is typically dependency installation
   * and remote builds. For static frontends this is usually a no-op.
   */
  setupEnvironment?(ctx: StrategyContext): Promise<void>;

  /**
   * Start or reload the application.
   *
   * Optional. For backend apps this means reloading PM2.
   * For static frontends this is usually a no-op (Caddy serves files).
   *
   * Blue-green backends start only the web colour here; workers wait for
   * `afterHealthy` so a failed health check does not leave them on the new release.
   */
  startApp?(ctx: StrategyContext): Promise<void>;

  /**
   * Optional step after the new release is healthy (and before traffic flip
   * completes recording). Blue-green backends reload workers here.
   */
  afterHealthy?(ctx: StrategyContext): Promise<void>;
}

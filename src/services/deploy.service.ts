import { execa } from 'execa';
import type { ShipnodeConfig } from '../shared/types.js';
import { getActiveApp } from '../domain/workspace.js';
import type { RemoteExecutor } from '../domain/remote/executor.js';
import { ReleaseManager, DeployLock } from '../domain/release/manager.js';
import { HealthCheckService } from '../services/health.service.js';
import { CaddyService } from '../services/caddy.service.js';
import { DeployOrchestrator } from '../domain/deploy/orchestrator.js';
import { BackendStrategy } from '../domain/deploy/backend-strategy.js';
import { FrontendStrategy } from '../domain/deploy/frontend-strategy.js';

/**
 * DeployService is a thin facade over the orchestrator and strategy.
 *
 * It wires the infrastructure (executor, config, cwd) into the domain
 * (orchestrator + strategy) and kicks off the deployment. All the
 * heavy lifting lives in the orchestrator and strategy modules.
 */
export class DeployService {
  private config: ShipnodeConfig;
  private orchestrator: DeployOrchestrator;
  private backendStrategy: BackendStrategy;
  private frontendStrategy: FrontendStrategy;

  constructor(
    executor: RemoteExecutor,
    config: ShipnodeConfig,
    private cwd: string,
  ) {
    this.config = config;
    const releases = new ReleaseManager(executor, config.remotePath, getActiveApp(config).keepReleases);
    const lock = new DeployLock(executor, config.remotePath);
    const healthCheck = new HealthCheckService(executor, config);
    const caddy = new CaddyService(executor, config);

    this.orchestrator = new DeployOrchestrator(
      config,
      executor,
      releases,
      lock,
      healthCheck,
      caddy,
    );

    this.backendStrategy = new BackendStrategy(config, cwd);
    this.frontendStrategy = new FrontendStrategy(config, cwd);
  }

  async execute(skipBuild = false): Promise<void> {
    const gitCommit = await getGitCommit(this.cwd);
    const strategy = getActiveApp(this.config).appType === 'backend'
      ? this.backendStrategy
      : this.frontendStrategy;

    await this.orchestrator.deploy(strategy, {
      cwd: this.cwd,
      skipBuild,
      gitCommit,
    });
  }
}

async function getGitCommit(cwd: string): Promise<string | undefined> {
  try {
    const result = await execa('git', ['rev-parse', '--short', 'HEAD'], { cwd });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

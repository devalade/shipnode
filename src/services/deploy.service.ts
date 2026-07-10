import { execa } from 'execa';
import type { ShipnodeConfig } from '../shared/types.js';
import type { RemoteExecutor } from '../domain/remote/executor.js';
import { DeployLock } from '../domain/release/manager.js';
import { HealthCheckService } from '../services/health.service.js';
import { CaddyService } from '../services/caddy.service.js';
import { AccessoryService } from '../services/accessory.service.js';
import { DeployOrchestrator } from '../domain/deploy/orchestrator.js';

export class DeployService {
  private orchestrator: DeployOrchestrator;

  constructor(
    executor: RemoteExecutor,
    config: ShipnodeConfig,
  ) {
    const lock = new DeployLock(executor, config.remotePath);
    const healthCheck = new HealthCheckService(executor, config);
    const caddy = new CaddyService(executor, config);
    const accessories = new AccessoryService(executor, config);

    this.orchestrator = new DeployOrchestrator(
      config,
      executor,
      lock,
      healthCheck,
      caddy,
      accessories,
    );
  }

  async execute(cwd: string, skipBuild = false): Promise<void> {
    const gitCommit = await getGitCommit(cwd);

    await this.orchestrator.deploy({
      cwd,
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

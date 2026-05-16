import type { ShipnodeConfig } from '../shared/types.js';
import type { RemoteExecutor } from '../domain/remote/executor.js';
import { HealthCheckError } from '../shared/errors.js';

export class HealthCheckService {
  constructor(
    private executor: RemoteExecutor,
    private config: ShipnodeConfig,
  ) {}

  async perform(): Promise<{ attempts: number; responseMs: number }> {
    if (!this.config.healthCheck.enabled) {
      return { attempts: 0, responseMs: 0 };
    }

    const { path, timeout, retries, startupDelay } = this.config.healthCheck;
    const port = this.config.backend?.port ?? 3000;
    const url = `http://localhost:${port}${path}`;

    // Wait for startup delay
    await this.sleep(startupDelay * 1000);

    let lastStatus = 0;
    let lastResponseMs = 0;

    for (let attempt = 1; attempt <= retries; attempt++) {
      const result = await this.executor.exec(
        `start_time=$(date +%s%N); ` +
        `status=$(curl -s -o /dev/null -w "%{http_code}" --max-time ${timeout} "${url}"); ` +
        `end_time=$(date +%s%N); ` +
        `echo "$status $(( (end_time - start_time) / 1000000 ))"`
      );

      const parts = result.stdout.split(' ');
      lastStatus = parseInt(parts[0], 10);
      lastResponseMs = parseInt(parts[1], 10);

      if (lastStatus >= 200 && lastStatus < 400) {
        return { attempts: attempt, responseMs: lastResponseMs };
      }
    }

    throw new HealthCheckError(
      `Health check failed after ${retries} attempts. Last status: ${lastStatus}`,
      retries,
      lastStatus,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

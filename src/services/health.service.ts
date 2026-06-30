import type { ShipnodeConfig, ShipnodeApp, Pm2App } from '../shared/types.js';
import type { RemoteExecutor } from '../domain/remote/executor.js';
import { HealthCheckError } from '../shared/errors.js';
import { getDeploymentName, getPm2Name } from '../domain/pm2/apps.js';

interface Pm2JlistEntry {
  name: string;
  pm2_env?: {
    status?: string;
    restart_time?: number;
  };
}

export class HealthCheckService {
  constructor(
    private executor: RemoteExecutor,
    private config: ShipnodeConfig,
  ) {}

  async perform(app: ShipnodeApp): Promise<{ attempts: number; responseMs: number }> {
    if (!app.healthCheck.enabled) {
      return { attempts: 0, responseMs: 0 };
    }

    const { startupDelay } = app.healthCheck;
    await this.sleep(startupDelay * 1000);

    const webApp = app.pm2?.apps.find((a) => a.port !== undefined);

    let attempts = 0;
    let responseMs = 0;

    if (webApp) {
      const result = await this.performHttpCheck(webApp, app.healthCheck);
      attempts = result.attempts;
      responseMs = result.responseMs;
    }

    if (app.pm2?.apps.length) {
      await this.performPm2StatusCheck(app.pm2.apps);
    }

    return { attempts, responseMs };
  }

  private async performHttpCheck(webApp: Pm2App, healthCheck: ShipnodeApp['healthCheck']): Promise<{ attempts: number; responseMs: number }> {
    const { path, timeout, retries } = healthCheck;
    const url = `http://localhost:${webApp.port}${path}`;

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

      if (attempt < retries) {
        await this.sleep(2000);
      }
    }

    const diagnostics = await this.collectPm2Logs(webApp.name);
    throw new HealthCheckError(
      `Health check failed after ${retries} attempts. Last status: ${lastStatus}` + diagnostics,
      retries,
      lastStatus,
    );
  }

  private async performPm2StatusCheck(apps: Pm2App[]): Promise<void> {
    const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
    const result = await this.executor.exec(`${mise} && mise exec -- pm2 jlist`);

    let parsed: Pm2JlistEntry[];
    try {
      parsed = JSON.parse(result.stdout.trim()) as Pm2JlistEntry[];
    } catch {
      throw new HealthCheckError(
        `Could not parse pm2 jlist output. stdout: ${result.stdout.slice(0, 200)}`,
        0,
        0,
      );
    }

    const namespace = getDeploymentName(this.config) ?? '';
    const byName = new Map(parsed.map((e) => [e.name, e]));
    const failures: string[] = [];

    for (const app of apps) {
      const pm2Name = getPm2Name(namespace, app.name);
      const entry = byName.get(pm2Name);
      if (!entry) {
        failures.push(`${app.name}: not running (no PM2 entry found)`);
        continue;
      }
      const status = entry.pm2_env?.status;
      const restarts = entry.pm2_env?.restart_time ?? 0;
      if (status !== 'online') {
        failures.push(`${app.name}: status=${status ?? 'unknown'}`);
        continue;
      }
      if (restarts > 0) {
        failures.push(`${app.name}: crashed during startup (restart_time=${restarts})`);
      }
    }

    if (failures.length === 0) return;

    let diagnostics = '';
    for (const app of apps) {
      const pm2Name = getPm2Name(namespace, app.name);
      const entry = byName.get(pm2Name);
      if (entry && entry.pm2_env?.status === 'online' && (entry.pm2_env?.restart_time ?? 0) === 0) continue;
      diagnostics += await this.collectPm2Logs(pm2Name);
    }

    throw new HealthCheckError(
      `PM2 process(es) failed health check:\n  - ${failures.join('\n  - ')}${diagnostics}`,
      0,
      0,
    );
  }

  private async collectPm2Logs(name: string): Promise<string> {
    const logResult = await this.executor.exec(
      `{ tail -15 ~/.pm2/logs/${name}-error.log 2>/dev/null; tail -15 ~/.pm2/logs/${name}-out.log 2>/dev/null; } || true`,
    ).catch(() => ({ stdout: '', stderr: '' }));
    const logs = logResult.stdout.trim();
    return logs ? `\n\nPM2 logs (${name}):\n${logs}` : '';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

import { describe, it, expect } from 'vitest';
import { HealthCheckService } from '../../src/services/health.service.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import { assembleConfig } from '../../src/config/assembly.js';
import { HealthCheckError } from '../../src/shared/errors.js';

function makeConfig(opts: { apps: Array<{ name: string; port?: number }>; healthCheckEnabled?: boolean }) {
  return assembleConfig({
    app: 'backend',
    ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
    remotePath: '/var/www/app',
    pm2: { apps: opts.apps },
    healthCheck: {
      enabled: opts.healthCheckEnabled ?? true,
      path: '/health',
      timeout: 5,
      retries: 1,
      startupDelay: 0,
    },
  });
}

// Always-online PM2 entries for the given names.
function pm2JlistOnline(names: string[]): string {
  return JSON.stringify(names.map((name) => ({ name, pm2_env: { status: 'online', restart_time: 0 } })));
}

describe('HealthCheckService.perform — PM2 status check', () => {
  it('passes when every app is online with restart_time=0', async () => {
    const config = makeConfig({ apps: [{ name: 'api', port: 3000 }, { name: 'worker' }] });
    const executor = new FakeRemoteExecutor();
    executor.when((c) => c.includes('curl'), { stdout: '200 12', stderr: '', exitCode: 0 });
    // Worker name is namespace-prefixed in PM2 (api-worker), web app stays unprefixed.
    executor.when((c) => c.includes('pm2 jlist'), { stdout: pm2JlistOnline(['api', 'api-worker']), stderr: '', exitCode: 0 });

    const result = await new HealthCheckService(executor, config).perform(config.apps[0]);
    expect(result.attempts).toBe(1);
  });

  it('worker-only deployment skips HTTP and only does PM2 status check', async () => {
    const config = makeConfig({ apps: [{ name: 'worker', port: undefined }] });
    const executor = new FakeRemoteExecutor();
    executor.when((c) => c.includes('pm2 jlist'), { stdout: pm2JlistOnline(['worker']), stderr: '', exitCode: 0 });

    const result = await new HealthCheckService(executor, config).perform(config.apps[0]);
    expect(result).toEqual({ attempts: 0, responseMs: 0 });
    expect(executor.getHistory().some((e) => e.command.includes('curl'))).toBe(false);
    expect(executor.getHistory().some((e) => e.command.includes('pm2 jlist'))).toBe(true);
  });

  it('fails when a worker is not online', async () => {
    const config = makeConfig({ apps: [{ name: 'api', port: 3000 }, { name: 'worker' }] });
    const executor = new FakeRemoteExecutor();
    executor.when((c) => c.includes('curl'), { stdout: '200 5', stderr: '', exitCode: 0 });
    executor.when((c) => c.includes('pm2 jlist'), {
      stdout: JSON.stringify([
        { name: 'api', pm2_env: { status: 'online', restart_time: 0 } },
        { name: 'api-worker', pm2_env: { status: 'errored', restart_time: 4 } },
      ]),
      stderr: '',
      exitCode: 0,
    });

    await expect(new HealthCheckService(executor, config).perform(config.apps[0])).rejects.toThrow(HealthCheckError);
    await expect(new HealthCheckService(executor, config).perform(config.apps[0])).rejects.toThrow(/worker: status=errored/);
  });

  it('fails when an app crash-looped during startup (restart_time > 0)', async () => {
    const config = makeConfig({ apps: [{ name: 'api', port: 3000 }] });
    const executor = new FakeRemoteExecutor();
    executor.when((c) => c.includes('curl'), { stdout: '200 5', stderr: '', exitCode: 0 });
    executor.when((c) => c.includes('pm2 jlist'), {
      stdout: JSON.stringify([{ name: 'api', pm2_env: { status: 'online', restart_time: 3 } }]),
      stderr: '',
      exitCode: 0,
    });

    await expect(new HealthCheckService(executor, config).perform(config.apps[0])).rejects.toThrow(/crashed during startup/);
  });

  it('fails when an expected app is missing from pm2 jlist', async () => {
    const config = makeConfig({ apps: [{ name: 'api', port: 3000 }, { name: 'worker' }] });
    const executor = new FakeRemoteExecutor();
    executor.when((c) => c.includes('curl'), { stdout: '200 5', stderr: '', exitCode: 0 });
    executor.when((c) => c.includes('pm2 jlist'), { stdout: pm2JlistOnline(['api']), stderr: '', exitCode: 0 });

    await expect(new HealthCheckService(executor, config).perform(config.apps[0])).rejects.toThrow(/worker: not running/);
  });

  it('still fails HTTP-first when the web app does not respond, without reaching PM2 check', async () => {
    const config = makeConfig({ apps: [{ name: 'api', port: 3000 }] });
    const executor = new FakeRemoteExecutor();
    executor.when((c) => c.includes('curl'), { stdout: '500 5', stderr: '', exitCode: 0 });
    executor.when((c) => c.includes('pm2 jlist'), { stdout: pm2JlistOnline(['api']), stderr: '', exitCode: 0 });

    await expect(new HealthCheckService(executor, config).perform(config.apps[0])).rejects.toThrow(/Health check failed/);
    expect(executor.getHistory().some((e) => e.command.includes('pm2 jlist'))).toBe(false);
  });

  it('returns immediately when health checks are disabled (no PM2 check either)', async () => {
    const config = makeConfig({ apps: [{ name: 'api', port: 3000 }], healthCheckEnabled: false });
    const executor = new FakeRemoteExecutor();

    const result = await new HealthCheckService(executor, config).perform(config.apps[0]);
    expect(result).toEqual({ attempts: 0, responseMs: 0 });
    expect(executor.getHistory()).toHaveLength(0);
  });
});

describe('HealthCheckService.perform — default vs. configured path', () => {
  function configWith(healthCheck: Record<string, unknown>) {
    return assembleConfig({
      app: 'backend',
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      remotePath: '/var/www/app',
      pm2: { apps: [{ name: 'api', port: 3000 }] },
      healthCheck: { timeout: 5, retries: 1, startupDelay: 0, ...healthCheck },
    });
  }

  function respond(status: string) {
    const executor = new FakeRemoteExecutor();
    executor.when((c) => c.includes('curl'), { stdout: `${status} 5`, stderr: '', exitCode: 0 });
    executor.when((c) => c.includes('pm2 jlist'), { stdout: pm2JlistOnline(['api']), stderr: '', exitCode: 0 });
    return executor;
  }

  it('accepts a 404 when no path was configured — the app is listening, it just has no /health route', async () => {
    const config = configWith({});
    expect(config.apps[0].healthCheck).toMatchObject({ path: '/health', strict: false });

    const result = await new HealthCheckService(respond('404'), config).perform(config.apps[0]);
    expect(result.attempts).toBe(1);
  });

  it('still fails a 5xx when no path was configured', async () => {
    const config = configWith({});
    await expect(new HealthCheckService(respond('502'), config).perform(config.apps[0])).rejects.toThrow(/Last status: 502/);
  });

  it('fails when nothing answers, and says to listen on PORT', async () => {
    const config = configWith({});
    await expect(new HealthCheckService(respond('000'), config).perform(config.apps[0])).rejects.toThrow(/Nothing answered on port 3000/);
  });

  it('holds a configured path to a 2xx/3xx and names the missing route', async () => {
    const config = configWith({ path: '/healthz' });
    expect(config.apps[0].healthCheck.strict).toBe(true);
    await expect(new HealthCheckService(respond('404'), config).perform(config.apps[0])).rejects.toThrow(/no route at \/healthz/);
  });
});

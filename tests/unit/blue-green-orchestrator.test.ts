import { describe, it, expect, vi } from 'vitest';
import { DeployOrchestrator } from '../../src/domain/deploy/orchestrator.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import { assembleConfig } from '../../src/config/assembly.js';
import type { DeployState } from '../../src/domain/deploy/blue-green.js';

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
}));
vi.mock('fs-extra', () => ({
  pathExists: vi.fn().mockResolvedValue(false),
}));

function bgConfig(overrides: Record<string, unknown> = {}): ReturnType<typeof assembleConfig> {
  return assembleConfig({
    app: 'backend',
    ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
    remotePath: '/var/www/app',
    domain: 'example.com',
    zeroDowntime: true,
    pm2: { apps: [{ name: 'app', port: 3000 }] },
    keepReleases: 5,
    healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 1, startupDelay: 0 },
    envFile: '.env',
    pkgManager: 'npm',
    ...(overrides as Parameters<typeof assembleConfig>[0]),
  });
}

async function buildOrchestrator(executor: FakeRemoteExecutor, config: ReturnType<typeof assembleConfig>) {
  const { DeployLock } = await import('../../src/domain/release/manager.js');
  const { HealthCheckService } = await import('../../src/services/health.service.js');
  const { CaddyService } = await import('../../src/services/caddy.service.js');
  return new DeployOrchestrator(
    config,
    executor,
    new DeployLock(executor, config.remotePath),
    new HealthCheckService(executor, config),
    new CaddyService(executor, config),
  );
}

/** Wire the baseline remote responses shared by every scenario. */
function baseStubs(executor: FakeRemoteExecutor): FakeRemoteExecutor {
  return executor
    .when((cmd) => cmd.includes('cat') && cmd.includes('releases.json'), { stdout: '[]', stderr: '', exitCode: 0 })
    .when((cmd) => cmd.includes('deploy.lock'), { stdout: 'OK', stderr: '', exitCode: 0 })
    .when((cmd) => cmd.includes('pm2 jlist') && !cmd.includes('select(.name == $n)'), {
      // health status check looks for the coloured web name; report both online
      stdout: JSON.stringify([
        { name: 'app-blue', pm2_env: { status: 'online', restart_time: 0 } },
        { name: 'app-green', pm2_env: { status: 'online', restart_time: 0 } },
      ]),
      stderr: '',
      exitCode: 0,
    });
}

describe('blue-green deploy (orchestrator)', () => {
  it('first deploy boots green and removes a legacy process only after the Caddy flip', async () => {
    const executor = new FakeRemoteExecutor();
    baseStubs(executor).when((cmd) => cmd.includes('date') && cmd.includes('curl'), { stdout: '200 12', stderr: '', exitCode: 0 });
    const config = bgConfig();
    const orchestrator = await buildOrchestrator(executor, config);

    await orchestrator.deploy({ cwd: '/test', skipBuild: false });

    const history = executor.getHistory();
    const cmds = history.map((h) => h.command);

    // green avoids interrupting a legacy uncoloured process on the blue port
    const webEco = cmds.find((c) => c.includes('ecosystem.web.config.cjs') && c.includes('echo'));
    expect(webEco).toBeDefined();
    expect(webEco).toContain('app-green');
    expect(webEco).toContain('PORT: 13000');

    const curl = cmds.find((c) => c.includes('curl') && c.includes('localhost:13000/health'));
    expect(curl).toBeDefined();

    // Caddy flipped to the green port and reloaded, then state persisted — in that order
    const caddyIdx = cmds.findIndex((c) => c.includes('reverse_proxy localhost:13000') && c.includes('tee'));
    const reloadIdx = cmds.findIndex((c) => c.includes('systemctl reload caddy'));
    const stateIdx = cmds.findIndex((c) => c.includes('deploy-state.json') && c.includes('base64 -d'));
    const cleanupIdx = cmds.findIndex((c) => c.includes('--arg n "app"') && c.includes('pm2 delete "$id"'));
    const curlIdx = cmds.findIndex((c) => c.includes('curl') && c.includes('/health'));
    expect(caddyIdx).toBeGreaterThan(curlIdx);
    expect(reloadIdx).toBeGreaterThan(caddyIdx);
    expect(stateIdx).toBeGreaterThan(reloadIdx);
    expect(cleanupIdx).toBeGreaterThan(stateIdx);
  });

  it('second deploy (blue active) targets green on the alt port', async () => {
    const executor = new FakeRemoteExecutor();
    const state: DeployState = { activeColor: 'blue', bluePort: 3000, greenPort: 3001 };
    baseStubs(executor)
      .when((cmd) => cmd.includes('deploy-state.json') && cmd.includes('cat'), { stdout: JSON.stringify(state), stderr: '', exitCode: 0 })
      .when((cmd) => cmd.includes('date') && cmd.includes('curl'), { stdout: '200 12', stderr: '', exitCode: 0 });
    const config = bgConfig();
    const orchestrator = await buildOrchestrator(executor, config);

    await orchestrator.deploy({ cwd: '/test', skipBuild: false });

    const cmds = executor.getHistory().map((h) => h.command);
    const webEco = cmds.find((c) => c.includes('ecosystem.web.config.cjs') && c.includes('echo'));
    expect(webEco).toContain('app-green');
    expect(webEco).toContain('PORT: 3001');
    expect(cmds.some((c) => c.includes('curl') && c.includes('localhost:3001/health'))).toBe(true);
    expect(cmds.some((c) => c.includes('reverse_proxy localhost:3001') && c.includes('tee'))).toBe(true);
  });

  it('reclaims the inactive colour only after Caddy switches traffic when retention is none', async () => {
    const executor = new FakeRemoteExecutor();
    const state: DeployState = { activeColor: 'blue', bluePort: 3000, greenPort: 3001 };
    baseStubs(executor)
      .when((cmd) => cmd.includes('deploy-state.json') && cmd.includes('cat'), { stdout: JSON.stringify(state), stderr: '', exitCode: 0 })
      .when((cmd) => cmd.includes('date') && cmd.includes('curl'), { stdout: '200 12', stderr: '', exitCode: 0 });
    const orchestrator = await buildOrchestrator(executor, bgConfig({ blueGreenRetention: 'none' }));

    await orchestrator.deploy({ cwd: '/test', skipBuild: false });

    const commands = executor.getHistory().map((entry) => entry.command);
    const caddyIdx = commands.findIndex((command) => command.includes('systemctl reload caddy'));
    const stateIdx = commands.findIndex((command) => command.includes('deploy-state.json') && command.includes('base64 -d'));
    const cleanupIdx = commands.findIndex((command) => command.includes('--arg n "app-blue"') && command.includes('pm2 delete "$id"'));
    expect(cleanupIdx).toBeGreaterThan(stateIdx);
    expect(stateIdx).toBeGreaterThan(caddyIdx);
  });

  it('second switch (green active) reuses blue only after the first migration cleaned it', async () => {
    const executor = new FakeRemoteExecutor();
    const state: DeployState = { activeColor: 'green', bluePort: 3000, greenPort: 3001 };
    baseStubs(executor)
      .when((cmd) => cmd.includes('deploy-state.json') && cmd.includes('cat'), { stdout: JSON.stringify(state), stderr: '', exitCode: 0 })
      .when((cmd) => cmd.includes('date') && cmd.includes('curl'), { stdout: '200 12', stderr: '', exitCode: 0 });
    const orchestrator = await buildOrchestrator(executor, bgConfig());

    await orchestrator.deploy({ cwd: '/test', skipBuild: false });

    const commands = executor.getHistory().map((entry) => entry.command);
    expect(commands.some((command) => command.includes('app-blue') && command.includes('PORT: 3000'))).toBe(true);
    expect(commands.some((command) => command.includes('localhost:3000/health'))).toBe(true);
    expect(commands.some((command) => command.includes('reverse_proxy localhost:3000'))).toBe(true);
  });

  it('health failure leaves the old colour serving — no Caddy flip, no state write', async () => {
    const executor = new FakeRemoteExecutor();
    baseStubs(executor)
      .when((cmd) => cmd.includes('readlink') && cmd.includes('/current'), {
        stdout: '/var/www/app/app/releases/2026-01-01T00-00-00-000Z',
        stderr: '',
        exitCode: 0,
      })
      .when((cmd) => cmd.includes('date') && cmd.includes('curl'), { stdout: '500 3', stderr: '', exitCode: 0 });
    const config = bgConfig();
    const orchestrator = await buildOrchestrator(executor, config);

    await expect(orchestrator.deploy({ cwd: '/test', skipBuild: false })).rejects.toThrow();

    const cmds = executor.getHistory().map((h) => h.command);
    expect(cmds.some((c) => c.includes('systemctl reload caddy'))).toBe(false);
    expect(cmds.some((c) => c.includes('deploy-state.json') && c.includes('base64 -d'))).toBe(false);
    expect(cmds.some((c) => c.includes('--arg n "app"') && c.includes('pm2 delete "$id"'))).toBe(false);
    // current reverted to the previous release
    expect(cmds.some((c) => c.includes('ln -sfn') && c.includes('2026-01-01T00-00-00-000Z'))).toBe(true);
    // failed release recorded
    const record = cmds.find((c) => c.includes('releases.json') && c.includes('base64 -d'));
    expect(record).toBeDefined();
    const b64 = record!.match(/printf '%s' '([^']+)'/)?.[1];
    expect(b64).toBeDefined();
    const decoded = JSON.parse(Buffer.from(b64!, 'base64').toString());
    expect(decoded.at(-1).status).toBe('failed');
  });

  it('does not revert current after traffic switched when legacy cleanup fails', async () => {
    const executor = new FakeRemoteExecutor();
    baseStubs(executor)
      .when((cmd) => cmd.includes('readlink') && cmd.includes('/current'), {
        stdout: '/var/www/app/app/releases/2026-01-01T00-00-00-000Z',
        stderr: '',
        exitCode: 0,
      })
      .when((cmd) => cmd.includes('date') && cmd.includes('curl'), { stdout: '200 12', stderr: '', exitCode: 0 })
      .when((cmd) => cmd.includes('--arg n "app"') && cmd.includes('pm2 delete "$id"'), { stdout: '', stderr: 'pm2 save failed', exitCode: 1 });
    const orchestrator = await buildOrchestrator(executor, bgConfig());

    await expect(orchestrator.deploy({ cwd: '/test', skipBuild: false })).rejects.toThrow('pm2 save failed');

    const commands = executor.getHistory().map((entry) => entry.command);
    expect(commands.some((command) => command.includes('systemctl reload caddy'))).toBe(true);
    expect(commands.some((command) => command.includes('deploy-state.json') && command.includes('base64 -d'))).toBe(true);
    expect(commands.some((command) => command.includes('ln -sfn') && command.includes('2026-01-01T00-00-00-000Z'))).toBe(false);
  });

  it('reloads workers after health and before the Caddy flip', async () => {
    const executor = new FakeRemoteExecutor();
    executor
      .when((cmd) => cmd.includes('cat') && cmd.includes('releases.json'), { stdout: '[]', stderr: '', exitCode: 0 })
      .when((cmd) => cmd.includes('deploy.lock'), { stdout: 'OK', stderr: '', exitCode: 0 })
      .when((cmd) => cmd.includes('pm2 jlist') && !cmd.includes('select(.name == $n)'), {
        stdout: JSON.stringify([
          { name: 'app-green', pm2_env: { status: 'online', restart_time: 0 } },
          { name: 'app-worker', pm2_env: { status: 'online', restart_time: 0 } },
        ]),
        stderr: '',
        exitCode: 0,
      })
      .when((cmd) => cmd.includes('date') && cmd.includes('curl'), { stdout: '200 12', stderr: '', exitCode: 0 });
    const config = bgConfig({
      pm2: { apps: [{ name: 'app', port: 3000 }, { name: 'worker', command: 'node dist/worker.js' }] },
    });
    const orchestrator = await buildOrchestrator(executor, config);

    await orchestrator.deploy({ cwd: '/test', skipBuild: false });

    const cmds = executor.getHistory().map((h) => h.command);
    const webStartIdx = cmds.findIndex((c) => c.includes('pm2 start') && c.includes('ecosystem.web.config.cjs'));
    const workersIdx = cmds.findIndex((c) => c.includes('ecosystem.workers.config.cjs') && (c.includes('pm2 reload') || c.includes('pm2 start')));
    const curlIdx = cmds.findIndex((c) => c.includes('curl') && c.includes('/health'));
    const caddyIdx = cmds.findIndex((c) => c.includes('systemctl reload caddy'));

    expect(webStartIdx).toBeGreaterThan(-1);
    expect(workersIdx).toBeGreaterThan(-1);
    expect(curlIdx).toBeGreaterThan(webStartIdx);
    expect(workersIdx).toBeGreaterThan(curlIdx);
    expect(caddyIdx).toBeGreaterThan(workersIdx);
  });

  it('uses the PM2 recreate path when zero downtime is explicitly disabled', async () => {
    const executor = new FakeRemoteExecutor();
    baseStubs(executor).when((cmd) => cmd.includes('date') && cmd.includes('curl'), { stdout: '200 12', stderr: '', exitCode: 0 });
    const orchestrator = await buildOrchestrator(executor, bgConfig({
      zeroDowntime: false,
      healthCheck: { enabled: false, path: '/health', timeout: 30, retries: 1, startupDelay: 0 },
    }));

    await orchestrator.deploy({ cwd: '/test', skipBuild: false });

    const commands = executor.getHistory().map((entry) => entry.command);
    expect(commands.some((command) => command.includes('ecosystem.config.cjs') && command.includes('pm2 start'))).toBe(true);
    expect(commands.some((command) => command.includes('ecosystem.web.config.cjs'))).toBe(false);
    expect(commands.some((command) => command.includes('deploy-state.json'))).toBe(false);
  });
});

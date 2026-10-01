import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import type { ShipnodeConfig } from '../../src/shared/types.js';

let executor: FakeRemoteExecutor;

vi.mock('../../src/config/loader.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/cli/prompt.js', () => ({ confirm: vi.fn() }));
vi.mock('../../src/cli/ui.js', () => ({
  ui: { banner: vi.fn(), step: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), note: vi.fn() },
}));
vi.mock('../../src/infrastructure/ssh/connection.js', () => ({
  SshConnection: class {
    async connect(): Promise<void> {}
    disconnect(): void {}
    exec(command: string, options?: { timeout?: number }): Promise<unknown> {
      return executor.exec(command, options);
    }
    execOrThrow(command: string, options?: { timeout?: number }): Promise<unknown> {
      return executor.execOrThrow(command, options);
    }
  },
}));

const { cmdRollback } = await import('../../src/cli/commands/rollback.js');
const { loadConfig } = await import('../../src/config/loader.js');
const { confirm } = await import('../../src/cli/prompt.js');
const { ui } = await import('../../src/cli/ui.js');

type Retention = 'warm' | 'rollback' | 'none';

function singleServer(overrides: { retention?: Retention; runtime?: 'watt' } = {}): ShipnodeConfig {
  return {
    ssh: { host: '10.0.0.11', user: 'deploy', port: 22 },
    servers: { main: { host: '10.0.0.11', user: 'deploy', port: 22 } },
    remotePath: '/var/www/app',
    nodeVersion: '22',
    apps: [{
      name: 'api',
      appType: 'backend',
      on: 'main',
      zeroDowntime: true,
      blueGreenRetention: overrides.retention ?? 'warm',
      ...(overrides.runtime ? { runtime: overrides.runtime, watt: { main: 'dist/server.js' } } : {}),
      domain: 'api.example.com',
      pm2: { apps: [{ name: 'api', port: 3000 }] },
      healthCheck: { enabled: false, path: '/health', timeout: 30, retries: 3, startupDelay: 0 },
      envFile: '.env',
      keepReleases: 5,
    }],
  } as unknown as ShipnodeConfig;
}

const STATE = { activeColor: 'blue', bluePort: 3000, greenPort: 13000, blueRelease: 'R2', greenRelease: 'R1' };
const pm2Online = (...names: string[]) =>
  JSON.stringify(names.map((name) => ({ name, pm2_env: { status: 'online' } })));

/** A host where `blue` serves, `green` is stopped, and both releases are on disk. */
function host(state: Record<string, unknown> = STATE): FakeRemoteExecutor {
  return new FakeRemoteExecutor()
    .when((c) => c.startsWith('cat ') && c.includes('deploy-state.json'), {
      stdout: JSON.stringify(state), stderr: '', exitCode: 0,
    })
    .when((c) => c.includes('pm2 jlist') && !c.includes('jq'), { stdout: pm2Online('api-blue'), stderr: '', exitCode: 0 })
    .when((c) => c.startsWith('readlink'), { stdout: '/var/www/app/api/releases/R2\n', stderr: '', exitCode: 0 });
}

const history = () => executor.getHistory().map((entry) => entry.command);
const indexOf = (needle: string) => history().findIndex((c) => c.includes(needle));

beforeEach(() => {
  vi.mocked(loadConfig).mockResolvedValue(singleServer());
  vi.mocked(confirm).mockReset().mockResolvedValue(true);
  vi.mocked(ui.error).mockReset();
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
});

async function rollback(): Promise<string | undefined> {
  try {
    await cmdRollback('/project', { app: 'api' });
    return undefined;
  } catch (error) {
    // Errors reach the user through ui.error + exit(1); anything thrown before
    // that point is a test-setup problem and must not pass for a clean run.
    return (vi.mocked(ui.error).mock.calls[0]?.[0] as string | undefined) ?? `UNEXPECTED: ${error instanceof Error ? (error.stack ?? '').split('\n').slice(0, 4).join(' | ') : String(error)}`;
  }
}

describe('warm blue-green rollback (PM2)', () => {
  it('starts the stopped colour from its own release, then flips, then stops the one that was serving', async () => {
    executor = host();

    expect(await rollback()).toBeUndefined();


    const link = indexOf('releases/R1');
    const start = indexOf('pm2 start');
    const stateWrite = history().findIndex((c) => c.includes('deploy-state.json') && c.includes('base64 -d'));
    const reap = indexOf('sleep 10');
    expect(link).toBeGreaterThanOrEqual(0);
    expect(history()[start]).toContain('ecosystem.web.config.cjs');
    // `current` moves before the start, the flip comes after it, and the old colour is stopped last.
    expect(link).toBeLessThan(start);
    expect(start).toBeLessThan(stateWrite);
    expect(stateWrite).toBeLessThan(reap);
    expect(history()[reap]).toContain('api-blue');
    expect(vi.mocked(confirm).mock.calls[0][0]).toContain('R1');
  });

  it('records the new active colour and leaves both release records in place', async () => {
    executor = host();

    await rollback();

    const written = history().find((c) => c.includes('deploy-state.json') && c.includes('base64 -d'))!;
    const b64 = /printf '%s' '([^']+)'/.exec(written)![1];
    expect(JSON.parse(Buffer.from(b64, 'base64').toString())).toEqual({ ...STATE, activeColor: 'green' });
  });

  it('flips without starting anything when the previous colour is still running', async () => {
    vi.mocked(loadConfig).mockResolvedValue(singleServer({ retention: 'rollback' }));
    // Both colours are running, so the previous one is still there to flip to.
    executor = new FakeRemoteExecutor()
      .when((c) => c.startsWith('cat ') && c.includes('deploy-state.json'), { stdout: JSON.stringify(STATE), stderr: '', exitCode: 0 })
      .when((c) => c.includes('pm2 jlist'), { stdout: pm2Online('api-blue', 'api-green'), stderr: '', exitCode: 0 });

    expect(await rollback()).toBeUndefined();

    expect(indexOf('pm2 start')).toBe(-1);
    expect(indexOf('sleep 10')).toBe(-1);
    expect(history().some((c) => c.includes('deploy-state.json') && c.includes('base64 -d'))).toBe(true);
  });

  it('puts everything back when the colour cannot start', async () => {
    executor = host().when((c) => c.includes('pm2 start'), { stdout: '', stderr: 'boom', exitCode: 1 });

    expect(await rollback()).toBeDefined();

    // `current` is pointed at R1 for the start and restored to R2 afterwards,
    // the half-started colour is removed, and traffic never moved.
    const links = history().filter((c) => c.includes('current.tmp') && c.includes('ln -sfn'));
    expect(links[0]).toContain('releases/R1');
    expect(links[links.length - 1]).toContain('releases/R2');
    expect(history().some((c) => c.includes('api-green') && c.includes('pm2 delete'))).toBe(true);
    expect(history().some((c) => c.includes('deploy-state.json') && c.includes('base64 -d'))).toBe(false);
  });

  it('reports the original failure, and how to recover, when restoring current also fails', async () => {
    executor = host()
      .when((c) => c.includes('pm2 start'), { stdout: '', stderr: 'boom', exitCode: 1 })
      .when((c) => c.includes('ln -sfn') && c.includes('releases/R2'), { stdout: '', stderr: 'disk error', exitCode: 1 });

    const reported = await rollback();

    expect(reported).toContain('boom');
    expect(reported).not.toContain('disk error');
    const warning = vi.mocked(ui.warn).mock.calls.map((c) => String(c[0])).find((m) => m.includes('restore it with'));
    expect(warning).toContain('releases/R1');
    expect(warning).toContain('ln -sfn "/var/www/app/api/releases/R2"');
  });

  it('declines cleanly and touches nothing', async () => {
    executor = host();
    vi.mocked(confirm).mockResolvedValue(false);

    expect(await rollback()).toBeUndefined();

    expect(indexOf('pm2 start')).toBe(-1);
    expect(indexOf('ln -sfn')).toBe(-1);
  });

  it('refuses when the server never recorded which release the colour ran', async () => {
    executor = host({ activeColor: 'blue', bluePort: 3000, greenPort: 13000 });

    expect(await rollback()).toMatch(/did not record which release/);
    expect(indexOf('pm2 start')).toBe(-1);
  });

  it('refuses when that release has been cleaned up', async () => {
    executor = host().when((c) => c.startsWith('test -d'), { stdout: '', stderr: '', exitCode: 1 });

    expect(await rollback()).toMatch(/no longer on the server/);
    expect(indexOf('pm2 start')).toBe(-1);
  });

  it('is refused under none, which keeps nothing to roll back to', async () => {
    vi.mocked(loadConfig).mockResolvedValue(singleServer({ retention: 'none' }));
    executor = host();

    expect(await rollback()).toMatch(/disabled because blueGreenRetention is "none"/);
  });
});

describe('warm blue-green rollback (watt)', () => {
  it('re-enables and starts the parked unit, then parks the one that was serving', async () => {
    vi.mocked(loadConfig).mockResolvedValue(singleServer({ runtime: 'watt' }));
    executor = host().when((c) => c.includes('systemctl is-active'), { stdout: '', stderr: '', exitCode: 3 });

    expect(await rollback()).toBeUndefined();

    const start = indexOf('systemctl enable shipnode-api-green');
    expect(history()[start]).toContain('systemctl restart shipnode-api-green');
    const park = indexOf('disable --now shipnode-api-blue');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(park).toBeGreaterThan(start);
  });
});

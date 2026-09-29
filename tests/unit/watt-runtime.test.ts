import { describe, it, expect, vi } from 'vitest';
import { BackendStrategy } from '../../src/domain/deploy/backend-strategy.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import { assembleConfig } from '../../src/config/assembly.js';
import { shipnode } from '../../src/config/builder.js';
import type { StrategyContext } from '../../src/domain/deploy/strategy.js';
import {
  parseSize, renderAppConfig, renderRunScript, renderRuntimeConfig, renderUnit, resolveWattUnits, wattUnitName,
} from '../../src/domain/runtime/watt.js';

vi.mock('execa', () => ({ execa: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }) }));
vi.mock('fs-extra', () => ({ pathExists: vi.fn().mockResolvedValue(false) }));

const watt = { main: 'dist/server.js' };

function config(overrides: Record<string, unknown> = {}) {
  return assembleConfig({
    app: 'backend',
    ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
    remotePath: '/var/www/app',
    pm2: { apps: [{ name: 'api', port: 3000, instances: 4, maxMemory: '512M' }, { name: 'mailer', command: 'node dist/mailer.js' }] },
    runtime: 'watt',
    watt,
    nodeVersion: 'lts',
    pkgManager: 'npm',
    ...overrides,
  } as never);
}

function ctx(executor: FakeRemoteExecutor, cfg = config(), extra: Partial<StrategyContext> = {}): StrategyContext {
  return { config: cfg, app: cfg.apps[0], executor, workDir: '/var/www/app/api/releases/1', cwd: '/local', skipBuild: false, ...extra } as StrategyContext;
}

const strategy = (cfg = config()) => new BackendStrategy(cfg, cfg.apps[0], '/local');
const cmds = (e: FakeRemoteExecutor) => e.getHistory().map((h) => h.command);

describe('watt config validation', () => {
  it('requires watt.main when runtime is watt', () => {
    expect(() => config({ watt: undefined })).toThrow(/watt\.main/);
  });
  it('rejects watt settings without the watt runtime', () => {
    expect(() => config({ runtime: undefined })).toThrow(/require runtime 'watt'/);
  });
  it('requires a web app', () => {
    expect(() => config({ pm2: { apps: [{ name: 'w', command: 'node w.js' }] } })).toThrow(/web app/);
  });
  it('defaults to pm2 (runtime unset) so existing configs are unchanged', () => {
    const cfg = config({ runtime: undefined, watt: undefined });
    expect(cfg.apps[0].runtime).toBeUndefined();
  });
  it('builds through the fluent builder', () => {
    const cfg = shipnode.backend().ssh({ host: '1.2.3.4', user: 'deploy' }).deployTo('/var/www/x')
      .pm2('x', { instances: 3 }).port(3000).runtime('watt', watt).build();
    expect(cfg.apps[0].runtime).toBe('watt');
    expect(cfg.apps[0].watt?.main).toBe('dist/server.js');
  });
});

describe('watt renderers', () => {
  it('maps instances to worker threads and uses a per-colour PORT placeholder', () => {
    const json = JSON.parse(renderRuntimeConfig({ name: 'api', port: 3000, instances: 4, maxMemory: '512M' }, watt));
    expect(json.workers).toEqual({ static: 4 });
    expect(json.server.port).toBe('{PORT}');
    expect(json.entrypoint).toBe('web');
    expect(json.health.maxHeapUsed).toBe(512 * 1024 ** 2);
  });
  it('points the capability at the configured entry file', () => {
    const json = JSON.parse(renderAppConfig({ main: 'dist/server.js', module: '@platformatic/node' }));
    expect(json.node.main).toBe('dist/server.js');
    expect(json.module).toBe('@platformatic/node');
  });
  it('parses sizes', () => {
    expect(parseSize('1G')).toBe(1024 ** 3);
    expect(parseSize('nope')).toBeUndefined();
  });
  it('names units with the colour suffix and PM2-style namespacing', () => {
    expect(wattUnitName('api', 'api', 'green')).toBe('shipnode-api-green');
    expect(wattUnitName('api', 'mailer')).toBe('shipnode-api-mailer');
  });
  it('renders a launcher that never sources the env file', () => {
    const script = renderRunScript({ cwd: '/c', command: 'node w.js', envFile: '/s/.env', env: { PORT: 1 } });
    expect(script).not.toContain('source ');
    expect(script).toContain('exec mise exec -- node w.js');
  });
  it('renders a restarting systemd unit', () => {
    const unit = renderUnit({ description: 'd', user: 'deploy', workingDirectory: '/w', script: '/w/run.sh' });
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('User=deploy');
  });
});

describe('BackendStrategy watt — recreate', () => {
  it('writes configs, installs a unit per process, and restarts them', async () => {
    const cfg = config({ zeroDowntime: false });
    const e = new FakeRemoteExecutor();
    await strategy(cfg).startApp!(ctx(e, cfg));
    const all = cmds(e);
    expect(all.some((c) => c.includes('shipnode.watt.json'))).toBe(true);
    expect(all.some((c) => c.includes('/etc/systemd/system/shipnode-api.service'))).toBe(true);
    expect(all.some((c) => c.includes('/etc/systemd/system/shipnode-api-mailer.service'))).toBe(true);
    expect(all.some((c) => c.includes('systemctl restart shipnode-api'))).toBe(true);
    expect(all.some((c) => c.includes('pm2 start'))).toBe(false);
    expect(all.some((c) => c.includes('wattpm'))).toBe(true);
  });

  it('fails fast with an actionable message when wattpm is not a dependency', async () => {
    const cfg = config({ zeroDowntime: false });
    const e = new FakeRemoteExecutor().when((c) => c.includes('bin/wattpm" ]'), { stdout: '', stderr: 'x', exitCode: 1 });
    await expect(strategy(cfg).startApp!(ctx(e, cfg))).rejects.toThrow();
  });
});

describe('BackendStrategy watt — blue-green', () => {
  const target = (o: Record<string, unknown> = {}) => ({ color: 'green', port: 13000, previousColor: 'blue', previousPort: 3000, bluePort: 3000, greenPort: 13000, ...o }) as never;
  const bg = () => config({ domain: 'api.example.com', zeroDowntime: true });

  it('boots the idle colour on its own port and holds workers back', async () => {
    const cfg = bg();
    const e = new FakeRemoteExecutor();
    await strategy(cfg).startApp!(ctx(e, cfg, { deployTarget: target() }));
    const all = cmds(e);
    const script = all.find((c) => c.includes('shipnode-run-api-green.sh') && c.includes('printf'));
    expect(script).toBeDefined();
    expect(all.some((c) => c.includes('systemctl restart shipnode-api-green'))).toBe(true);
    expect(all.some((c) => c.includes('13000'))).toBe(true);
    expect(all.some((c) => c.includes('systemctl restart shipnode-api-mailer'))).toBe(false);
  });

  it('starts workers only after the new colour is healthy', async () => {
    const cfg = bg();
    const e = new FakeRemoteExecutor();
    await strategy(cfg).afterHealthy!(ctx(e, cfg, { deployTarget: target() }));
    expect(cmds(e).some((c) => c.includes('systemctl restart shipnode-api-mailer'))).toBe(true);
  });

  it('keeps the previous colour when retention is rollback', async () => {
    const cfg = bg();
    const e = new FakeRemoteExecutor();
    await strategy(cfg).afterTrafficSwitch!(ctx(e, cfg, { deployTarget: target() }));
    expect(cmds(e)).toHaveLength(0);
  });

  it('stops the previous colour when retention is none', async () => {
    const cfg = config({ domain: 'api.example.com', zeroDowntime: true, blueGreenRetention: 'none' });
    const e = new FakeRemoteExecutor();
    await strategy(cfg).afterTrafficSwitch!(ctx(e, cfg, { deployTarget: target() }));
    expect(cmds(e).some((c) => c.includes('systemctl stop shipnode-api-blue'))).toBe(true);
  });

  it('retires the pre-blue-green unit and any PM2 process on the first flip', async () => {
    const cfg = bg();
    const e = new FakeRemoteExecutor();
    await strategy(cfg).afterTrafficSwitch!(ctx(e, cfg, { deployTarget: target({ previousColor: null }) }));
    const all = cmds(e);
    expect(all.some((c) => c.includes('disable --now shipnode-api'))).toBe(true);
    expect(all.some((c) => c.includes('pm2 delete "api"'))).toBe(true);
  });
});

describe('resolveWattUnits', () => {
  it('targets the active colour for the web unit and plain names for workers', async () => {
    const cfg = config({ domain: 'api.example.com', zeroDowntime: true });
    const e = new FakeRemoteExecutor().when((c) => c.includes('deploy-state.json'), {
      stdout: JSON.stringify({ activeColor: 'green', bluePort: 3000, greenPort: 13000 }), stderr: '', exitCode: 0,
    });
    const units = await resolveWattUnits(e, '/var/www/app/api', cfg.apps[0], { colors: 'active' });
    expect(units).toEqual(['shipnode-api-green', 'shipnode-api-mailer']);
    const all = await resolveWattUnits(e, '/var/www/app/api', cfg.apps[0], { colors: 'all', process: 'api' });
    expect(all).toEqual(['shipnode-api-green', 'shipnode-api-blue']);
  });
  it('rejects an unknown process', async () => {
    const cfg = config();
    await expect(resolveWattUnits(new FakeRemoteExecutor(), '/x', cfg.apps[0], { colors: 'active', process: 'nope' })).rejects.toThrow(/No process named/);
  });
});

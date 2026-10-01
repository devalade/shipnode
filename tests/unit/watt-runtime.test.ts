import { describe, it, expect, vi } from 'vitest';
import { BackendStrategy } from '../../src/domain/deploy/backend-strategy.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import { assembleConfig } from '../../src/config/assembly.js';
import { shipnode } from '../../src/config/builder.js';
import type { StrategyContext } from '../../src/domain/deploy/strategy.js';
import {
  parseSize, renderAppConfig, renderRunScript, renderRuntimeConfig, renderUnit, resolveWattUnits, wattUnitName,
  wattEnsureInstalledCommand, WATT_VERSION,
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

// ── observe / health / monitor on watt ───────────────────────────────────────

import { parseSystemdUnits } from '../../src/domain/observe/parse.js';
import { buildObserveScript, wattCandidateUnits } from '../../src/domain/observe/script.js';
import { HealthCheckService } from '../../src/services/health.service.js';
import { restartProcess } from '../../src/cli/monitor/actions.js';
import { collectLogs } from '../../src/cli/monitor/poller.js';

const UNITS_OUTPUT = `@unit shipnode-api-green
LoadState=loaded
ActiveState=active
SubState=running
MainPID=4242
MemoryCurrent=268435456
NRestarts=0
ExecMainStatus=0
CPUUsageNSec=1000000000
started=1790000000
@unit shipnode-api-blue
LoadState=not-found
ActiveState=inactive
SubState=dead
MainPID=0
MemoryCurrent=[not set]
NRestarts=0
ExecMainStatus=0
CPUUsageNSec=[not set]
started=
@unit shipnode-api-mailer
LoadState=loaded
ActiveState=activating
SubState=auto-restart
MainPID=0
MemoryCurrent=[not set]
NRestarts=3
ExecMainStatus=1
CPUUsageNSec=5
started=
@wall 200000000
@cpu shipnode-api-green 1100000000
@cpu shipnode-api-mailer 5
`;

describe('parseSystemdUnits', () => {
  const procs = parseSystemdUnits(UNITS_OUTPUT, 'api', { unitBase: 'shipnode-api', instances: 4 });

  it('drops units that do not exist', () => {
    expect(procs.map((p) => p.pm2Name)).toEqual(['shipnode-api-green', 'shipnode-api-mailer']);
  });
  it('maps state, memory, pid and uptime onto the dashboard vocabulary', () => {
    const web = procs[0];
    expect(web).toMatchObject({ status: 'online', pid: 4242, memory: 256, supervisor: 'systemd', execMode: 'threads', instances: 4, uptime: 1790000000_000 });
  });
  it('derives CPU% from two samples of the cumulative counter', () => {
    // 100ms of CPU over a 200ms window = 50%
    expect(procs[0].cpu).toBe(50);
  });
  it('reports a crash-looping worker as errored with its restart count', () => {
    expect(procs[1]).toMatchObject({ status: 'errored', restarts: 3, pid: null, execMode: 'fork', exitCode: 1 });
  });
  it('tolerates empty output', () => {
    expect(parseSystemdUnits('', 'api')).toEqual([]);
  });
});

describe('observe script for watt apps', () => {
  it('samples systemd units instead of pm2', () => {
    const cfg = config();
    const script = buildObserveScript(cfg, { apps: [cfg.apps[0]] });
    expect(script).toContain('systemctl show');
    expect(script).not.toContain('pm2 jlist');
    expect(wattCandidateUnits(cfg.apps[0])).toEqual([
      'shipnode-api', 'shipnode-api-blue', 'shipnode-api-green', 'shipnode-api-mailer',
    ]);
  });
});

describe('deploy health check on watt', () => {
  const app = () => config({ zeroDowntime: false }).apps[0];
  const svc = (e: FakeRemoteExecutor) => new HealthCheckService(e, config());
  const ok = (e: FakeRemoteExecutor) => e.when((c) => c.includes('curl'), { stdout: '200 5', stderr: '', exitCode: 0 });

  it('passes when every unit is active with no restarts', async () => {
    const e = ok(new FakeRemoteExecutor()).when((c) => c.includes('systemctl show'), { stdout: 'active 0', stderr: '', exitCode: 0 });
    await expect(svc(e).perform({ ...app(), healthCheck: { ...app().healthCheck, startupDelay: 0 } })).resolves.toBeDefined();
    expect(e.getHistory().some((h) => h.command.includes('pm2'))).toBe(false);
  });
  it('fails on an inactive unit and includes journal output', async () => {
    const e = ok(new FakeRemoteExecutor())
      .when((c) => c.includes('journalctl'), { stdout: 'boom: cannot find module', stderr: '', exitCode: 0 })
      .when((c) => c.includes('systemctl show'), { stdout: 'failed 0', stderr: '', exitCode: 0 });
    await expect(svc(e).perform({ ...app(), healthCheck: { ...app().healthCheck, startupDelay: 0 } })).rejects.toThrow(/state=failed[\s\S]*cannot find module/);
  });
  it('fails a unit that systemd already restarted (crash loop)', async () => {
    const e = ok(new FakeRemoteExecutor()).when((c) => c.includes('systemctl show'), { stdout: 'active 2', stderr: '', exitCode: 0 });
    await expect(svc(e).perform({ ...app(), healthCheck: { ...app().healthCheck, startupDelay: 0 } })).rejects.toThrow(/NRestarts=2/);
  });
  it('checks the coloured unit during blue-green', async () => {
    const e = ok(new FakeRemoteExecutor()).when((c) => c.includes('systemctl show'), { stdout: 'active 0', stderr: '', exitCode: 0 });
    const a = app();
    await svc(e).perform({ ...a, healthCheck: { ...a.healthCheck, startupDelay: 0 } }, {
      httpPort: 13000,
      pm2Apps: [a.pm2!.apps[0]],
      resolvePm2Name: (p) => `${p.name}-green`,
    });
    expect(e.getHistory().some((h) => h.command.includes('shipnode-api-green'))).toBe(true);
  });
});

describe('monitor actions on watt', () => {
  it('restarts a single unit through systemd', async () => {
    const e = new FakeRemoteExecutor();
    const result = await restartProcess(e, 'shipnode-api-green', 'systemd');
    expect(result.isOk()).toBe(true);
    expect(e.getLastCommand()?.command).toContain('systemctl restart shipnode-api-green');
    expect(e.getLastCommand()?.command).not.toContain('pm2');
  });
  it('tails the journal for a whole deployment by glob', async () => {
    const e = new FakeRemoteExecutor();
    await collectLogs(e, 'api', 20, 'systemd');
    const cmd = e.getLastCommand()!.command;
    expect(cmd).toContain("journalctl -u 'shipnode-api' -u 'shipnode-api-*'");
  });
});

describe('wattEnsureInstalledCommand', () => {
  it('installs wattpm and the default module at the pinned version when missing', () => {
    const cmd = wattEnsureInstalledCommand('/srv/app/current', watt, 'pnpm');
    expect(cmd).toContain(`wattpm@${WATT_VERSION}`);
    expect(cmd).toContain(`@platformatic/node@${WATT_VERSION}`);
    expect(cmd).toContain('pnpm add $pkgs');
    expect(cmd).toContain('cd "/srv/app/current"');
  });

  it('only checks for packages the app has not already installed', () => {
    const cmd = wattEnsureInstalledCommand('/srv/app/current', watt, 'npm');
    expect(cmd).toContain('[ -x "/srv/app/current/node_modules/.bin/wattpm" ] || pkgs=');
    expect(cmd).toContain('[ -d "/srv/app/current/node_modules/@platformatic/node" ] || pkgs=');
    expect(cmd).toContain('npm install --no-audit --no-fund $pkgs');
  });

  it('never auto-installs a custom capability module', () => {
    const cmd = wattEnsureInstalledCommand('/srv/app/current', { ...watt, module: '@platformatic/next' }, 'npm');
    expect(cmd).not.toContain('@platformatic/next');
    expect(cmd).not.toContain('@platformatic/node@');
  });

  it('keeps the rendered schema version in step with the installed version', () => {
    expect(renderRuntimeConfig({ name: 'api', port: 3000 } as never, watt)).toContain(`wattpm/${WATT_VERSION}.json`);
    expect(renderAppConfig(watt)).toContain(`@platformatic/node/${WATT_VERSION}.json`);
  });
});

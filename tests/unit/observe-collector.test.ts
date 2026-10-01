import { describe, it, expect } from 'vitest';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import { assembleConfig } from '../../src/config/assembly.js';
import { buildObserveScript, appSectionName } from '../../src/domain/observe/script.js';
import { MetricsCollector } from '../../src/domain/observe/collector.js';

const config = assembleConfig({
  app: 'backend',
  ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
  remotePath: '/var/www/app',
  pm2: { apps: [{ name: 'api', port: 3000 }] },
});

const frontendConfig = assembleConfig({
  app: 'frontend',
  ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
  remotePath: '/var/www/app',
});

function sectioned(sections: Record<string, string>): string {
  return Object.entries(sections)
    .map(([name, body]) => `@@SHIPNODE:${name}@@\n${body}`)
    .join('\n');
}

const SYSTEM = 'mem:2048 1024\nload:0.5 0.4 0.3\ncores:2\nuptime:1000\ndisk:40 10';

describe('buildObserveScript', () => {
  it('emits host-level sections once, not once per app', () => {
    const two = { ...config, apps: [config.apps[0], { ...config.apps[0], name: 'worker' }] };
    const command = buildObserveScript(two, { apps: two.apps });

    expect(command.match(/@@SHIPNODE:sys@@/g)).toHaveLength(1);
    expect(command.match(/@@SHIPNODE:lock@@/g)).toHaveLength(1);
  });

  it('addresses each app by index so app names never enter the marker grammar', () => {
    const two = { ...config, apps: [config.apps[0], { ...config.apps[0], name: 'has spaces & pipes' }] };
    const command = buildObserveScript(two, { apps: two.apps });

    expect(command).toContain('@@SHIPNODE:a0-pm2@@');
    expect(command).toContain('@@SHIPNODE:a1-pm2@@');
  });

  it('joins sections with ; so one failure cannot blank the rest', () => {
    expect(buildObserveScript(config, { apps: config.apps })).not.toContain('&&');
  });

  it('gives pm2 a failure sentinel fallback for backend apps', () => {
    expect(buildObserveScript(config, { apps: config.apps })).toContain(
      'pm2 jlist 2>/dev/null || echo "##SHIPNODE_PM2_FAILED##"',
    );
  });

  it('skips pm2 and adds caddy sections for frontend apps', () => {
    const command = buildObserveScript(frontendConfig, { apps: frontendConfig.apps });
    expect(command).not.toContain('pm2 jlist');
    expect(command).toContain('@@SHIPNODE:a0-caddy-status@@');
    expect(command).toContain('@@SHIPNODE:a0-caddy-log@@');
  });

  it('reads the workspace-level deploy lock', () => {
    expect(buildObserveScript(config, { apps: config.apps })).toContain('/var/www/app/.shipnode/deploy.lock');
  });

  it('omits the accessories section when none are requested', () => {
    expect(buildObserveScript(config, { apps: config.apps })).not.toContain('@@SHIPNODE:accessories@@');
    expect(buildObserveScript(config, { apps: config.apps, accessoryNames: ['postgres'] })).toContain(
      '@@SHIPNODE:accessories@@',
    );
  });

  it('bounds the health probe by the poll interval', () => {
    const command = buildObserveScript(config, { apps: config.apps, healthMaxTimeSeconds: 2 });
    expect(command).toContain('--max-time 2');
  });

  it('emits no app sections for an empty app list', () => {
    const command = buildObserveScript(config, { apps: [] });
    expect(command).toContain('@@SHIPNODE:sys@@');
    expect(command).not.toContain('a0-');
  });
});

describe('MetricsCollector', () => {
  it('parses a full server snapshot', async () => {
    const executor = new FakeRemoteExecutor().when(
      () => true,
      {
        stdout: sectioned({
          sys: SYSTEM,
          lock: 'none',
          [appSectionName(0, 'pm2')]: JSON.stringify([
            { name: 'api', pid: 42, pm2_env: { status: 'online' }, monit: { cpu: 5, memory: 104857600 } },
          ]),
          [appSectionName(0, 'current')]: '/var/www/app/backend/releases/20260830010101',
          [appSectionName(0, 'releases')]: '[]',
          [appSectionName(0, 'health')]: '200 12',
        }),
        stderr: '',
        exitCode: 0,
      },
    );

    const snapshot = await new MetricsCollector(executor, 'a.example.com', config).collect({ apps: config.apps });

    expect(snapshot.server).toBe('a.example.com');
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.system.cores).toBe(2);
    expect(snapshot.deployLock).toBeNull();
    expect(snapshot.apps).toHaveLength(1);
    expect(snapshot.apps[0].app).toBe('api');
    expect(snapshot.apps[0].processes[0].pm2Name).toBe('api');
    expect(snapshot.apps[0].currentRelease).toBe('/var/www/app/backend/releases/20260830010101');
    expect(snapshot.apps[0].health).toEqual({ status: 'ok', httpCode: 200, responseMs: 12 });
  });

  it('degrades one failing section without blanking the rest', async () => {
    const executor = new FakeRemoteExecutor().when(() => true, {
      stdout: sectioned({
        sys: SYSTEM,
        lock: 'none',
        [appSectionName(0, 'pm2')]: '##SHIPNODE_PM2_FAILED##',
        [appSectionName(0, 'current')]: '/var/www/app/backend/releases/20260830010101',
        [appSectionName(0, 'releases')]: '[]',
      }),
      stderr: '',
      exitCode: 0,
    });

    const snapshot = await new MetricsCollector(executor, 'a', config).collect({ apps: config.apps });

    expect(snapshot.error).toBeUndefined();
    expect(snapshot.system.cores).toBe(2);
    expect(snapshot.apps[0].error).toBe('PM2 command failed');
    expect(snapshot.apps[0].currentRelease).not.toBeNull();
  });

  it('reports an unreachable host as a snapshot, not a throw', async () => {
    const executor = new (class extends FakeRemoteExecutor {
      override async exec(): Promise<never> {
        throw new Error('connect ETIMEDOUT');
      }
    })();

    const snapshot = await new MetricsCollector(executor, 'b', config).collect({ apps: config.apps });

    expect(snapshot.error).toBe('connect ETIMEDOUT');
    expect(snapshot.apps).toEqual([]);
    expect(snapshot.server).toBe('b');
  });

  it('records which apps a failed poll was meant to cover', async () => {
    const executor = new (class extends FakeRemoteExecutor {
      override async exec(): Promise<never> {
        throw new Error('connect ETIMEDOUT');
      }
    })();
    const planned = config.apps.map((a) => ({ app: a.name, appType: a.appType }));

    const timedOut = await new MetricsCollector(executor, 'b', config).collect({ apps: config.apps });
    const empty = await new MetricsCollector(
      new FakeRemoteExecutor().when(() => true, { stdout: '', stderr: '', exitCode: 0 }), 'c', config,
    ).collect({ apps: config.apps });

    expect(timedOut.plannedApps).toEqual(planned);
    expect(empty.plannedApps).toEqual(planned);
  });

  it('reports empty output as an error rather than an empty snapshot', async () => {
    const executor = new FakeRemoteExecutor().when(() => true, { stdout: '', stderr: '', exitCode: 0 });
    const snapshot = await new MetricsCollector(executor, 'c', config).collect({ apps: config.apps });
    expect(snapshot.error).toBe('Observe poll returned no data');
  });

  it('keeps apps addressable independently when several share a server', async () => {
    const two = { ...config, apps: [config.apps[0], { ...config.apps[0], name: 'worker' }] };
    const executor = new FakeRemoteExecutor().when(() => true, {
      stdout: sectioned({
        sys: SYSTEM,
        lock: 'none',
        [appSectionName(0, 'pm2')]: '[]',
        [appSectionName(0, 'current')]: '/var/www/app/backend/releases/1',
        [appSectionName(0, 'releases')]: '[]',
        [appSectionName(1, 'pm2')]: '[]',
        [appSectionName(1, 'current')]: 'none',
        [appSectionName(1, 'releases')]: '[]',
      }),
      stderr: '',
      exitCode: 0,
    });

    const snapshot = await new MetricsCollector(executor, 'a', two).collect({ apps: two.apps });

    expect(snapshot.apps.map((a) => a.app)).toEqual(['api', 'worker']);
    expect(snapshot.apps[0].currentRelease).toBe('/var/www/app/backend/releases/1');
    expect(snapshot.apps[1].currentRelease).toBeNull();
  });

  it('carries the accessories section only when it was requested', async () => {
    const stdout = sectioned({
      sys: SYSTEM,
      lock: 'none',
      [appSectionName(0, 'pm2')]: '[]',
      [appSectionName(0, 'current')]: 'none',
      [appSectionName(0, 'releases')]: '[]',
    });
    const executor = new FakeRemoteExecutor().when(() => true, { stdout, stderr: '', exitCode: 0 });

    const snapshot = await new MetricsCollector(executor, 'a', config).collect({ apps: config.apps });
    expect(snapshot.accessories).toBeUndefined();
  });

  it('bounds the SSH timeout by the poll interval', async () => {
    const executor = new FakeRemoteExecutor().when(() => true, {
      stdout: sectioned({ sys: SYSTEM, lock: 'none' }),
      stderr: '',
      exitCode: 0,
    });

    await new MetricsCollector(executor, 'a', config).collect({ apps: [], intervalSeconds: 3 });
    expect(executor.getLastCommand()?.options?.timeout).toBe(9000);
  });
});

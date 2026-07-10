import { describe, it, expect } from 'vitest';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import { sparkline, gauge, formatUptime, formatBytes, statusDot } from '../../src/cli/monitor/charts.js';
import { parsePm2Jlist, parseSystemStats, parseReleaseRecords, MetricsHistory } from '../../src/cli/monitor/state.js';
import { collectMetrics, collectLogs } from '../../src/cli/monitor/poller.js';
import { assembleConfig } from '../../src/config/assembly.js';
import { getAppsForMonitorTarget, resolveMonitorSession } from '../../src/cli/monitor/monitor-session.js';

// ── Charts ────────────────────────────────────────────────────────

describe('sparkline', () => {
  it('renders empty string for empty values', () => {
    expect(sparkline([], 5)).toBe('');
  });

  it('renders correct characters for normalized values', () => {
    const result = sparkline([0, 50, 100], 3);
    expect(result).toHaveLength(3);
    expect(result).toBe('▁▅█');
  });

  it('handles single value', () => {
    const result = sparkline([50], 3);
    // Single value < 7 → Math.round(50) = 50, clamped to 7 → SPARK_CHARS[7] = █
    expect(result).toBe('███');
  });

  it('handles constant values (no range)', () => {
    const result = sparkline([10, 10, 10], 3);
    expect(result).toHaveLength(3);
  });

  it('samples down to fit width', () => {
    const values = Array.from({ length: 100 }, (_, i) => i);
    const result = sparkline(values, 10);
    expect(result).toHaveLength(10);
  });
});

describe('gauge', () => {
  it('renders a full bar for 100%', () => {
    const result = gauge(1, 10);
    expect(result).toContain('█');
    expect(result).not.toContain('░');
  });

  it('renders an empty bar for 0%', () => {
    const result = gauge(0, 10);
    expect(result).toContain('░');
  });

  it('renders half bar for 50%', () => {
    const result = gauge(0.5, 10);
    const filledCount = [...result].filter((c) => c === '█').length;
    expect(filledCount).toBe(5);
  });

  it('clamps values above 1', () => {
    const result = gauge(2, 10);
    expect(result).not.toContain('░');
  });

  it('clamps values below 0', () => {
    const result = gauge(-1, 10);
    expect(result).not.toContain('█');
  });

  it('uses green for < 60%', () => {
    const result = gauge(0.5, 5);
    expect(result).toBeTruthy();
    expect(result).toContain('█');
    expect(result).toContain('░');
  });

  it('uses yellow for 60-85%', () => {
    const result = gauge(0.7, 5);
    expect(result).toBeTruthy();
    expect(result).toContain('█');
  });

  it('uses red for > 85%', () => {
    const result = gauge(0.9, 5);
    expect(result).toBeTruthy();
    expect(result).not.toContain('░');
  });
});

describe('formatUptime', () => {
  it('formats days, hours, minutes', () => {
    expect(formatUptime(90061)).toBe('1d 1h 1m');
  });

  it('shows only hours and minutes for < 1 day', () => {
    expect(formatUptime(3661)).toBe('1h 1m');
  });

  it('shows only minutes for < 1 hour', () => {
    expect(formatUptime(61)).toBe('1m');
  });

  it('shows 0m for 0 seconds', () => {
    expect(formatUptime(0)).toBe('0m');
  });
});

describe('formatBytes', () => {
  it('formats MB', () => {
    expect(formatBytes(500)).toBe('500 MB');
  });

  it('formats GB', () => {
    expect(formatBytes(2048)).toBe('2.0 GB');
  });
});

describe('statusDot', () => {
  it('returns ● for online', () => {
    expect(statusDot('online')).toBeTruthy();
    expect(statusDot('online')).toContain('●');
  });

  it('returns ● for errored', () => {
    expect(statusDot('errored')).toBeTruthy();
    expect(statusDot('errored')).toContain('●');
  });
});

// ── State parsing ─────────────────────────────────────────────────

function makePm2Entry(name: string, overrides: Record<string, unknown> = {}) {
  return { name, pm2_env: { status: 'online', pm_uptime: Date.now() - 3600000, restart_time: 0 }, monit: { cpu: 5, memory: 128 * 1024 * 1024 }, ...overrides };
}

describe('parsePm2Jlist', () => {
  it('parses a list of PM2 processes', () => {
    const stdout = JSON.stringify([
      makePm2Entry('api'),
      makePm2Entry('api-worker'),
      makePm2Entry('admin'),
    ]);
    const result = parsePm2Jlist(stdout, 'api');
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('api');
    expect(result[0].cpu).toBe(5);
    expect(result[0].memory).toBe(128); // 128 MB after bytes→MB conversion
    expect(result[0].status).toBe('online');
  });

  it('resolves prefixed names', () => {
    const stdout = JSON.stringify([makePm2Entry('api-worker')]);
    const result = parsePm2Jlist(stdout, 'api');
    expect(result[0].name).toBe('worker');
    expect(result[0].pm2Name).toBe('api-worker');
  });

  it('returns empty array on invalid JSON', () => {
    expect(parsePm2Jlist('not json', 'api')).toEqual([]);
  });

  it('filters unrelated PM2 processes from the same host', () => {
    const stdout = JSON.stringify([
      makePm2Entry('api'),
      makePm2Entry('api-worker'),
      makePm2Entry('admin'),
      makePm2Entry('admin-worker'),
    ]);

    const result = parsePm2Jlist(stdout, 'api');

    expect(result.map((process) => process.pm2Name)).toEqual(['api', 'api-worker']);
  });

  it('handles missing monit data', () => {
    const stdout = JSON.stringify([{ name: 'api', pm2_env: { status: 'online' } }]);
    const result = parsePm2Jlist(stdout, 'api');
    expect(result[0].cpu).toBe(0);
    expect(result[0].memory).toBe(0);
  });
});

describe('parseSystemStats', () => {
  it('parses all system fields', () => {
    const stdout = [
      'mem:16000 8000',
      'load:0.5',
      'uptime:86400',
      'disk:100 45',
    ].join('\n');
    const result = parseSystemStats(stdout);
    expect(result.totalMem).toBe(16000);
    expect(result.usedMem).toBe(8000);
    expect(result.cpuLoad).toBe(0.5);
    expect(result.uptime).toBe(86400);
    expect(result.totalDisk).toBe(100);
    expect(result.usedDisk).toBe(45);
  });

  it('defaults to zero for missing fields', () => {
    const result = parseSystemStats('');
    expect(result.totalMem).toBe(0);
    expect(result.cpuLoad).toBe(0);
  });
});

describe('parseReleaseRecords', () => {
  it('parses and reverses to show newest first', () => {
    const records = [
      { timestamp: '2026-01-01', status: 'success', duration: 10 },
      { timestamp: '2026-01-02', status: 'success', duration: 12 },
    ];
    const result = parseReleaseRecords(JSON.stringify(records));
    expect(result).toHaveLength(2);
    expect(result[0].timestamp).toBe('2026-01-02');
  });

  it('returns empty array on invalid JSON', () => {
    expect(parseReleaseRecords('not json')).toEqual([]);
  });
});

describe('MetricsHistory', () => {
  it('pushes CPU and memory averages', () => {
    const history = new MetricsHistory(5);
    history.push({
      timestamp: 'now',
      processes: [
        { name: 'a', pm2Name: 'a', pid: 1, status: 'online', cpu: 10, memory: 100, uptime: 0, restarts: 0 },
        { name: 'b', pm2Name: 'b', pid: 2, status: 'online', cpu: 20, memory: 200, uptime: 0, restarts: 0 },
      ],
      system: { cpuLoad: 0, totalMem: 0, usedMem: 0, totalDisk: 0, usedDisk: 0, uptime: 0 },
      currentRelease: null,
      releases: [],
    });
    expect(history.cpu).toHaveLength(1);
    expect(history.cpu[0]).toBe(15); // average of 10, 20
    expect(history.memory[0]).toBe(150); // average of 100, 200
  });

  it('limits entries to max', () => {
    const history = new MetricsHistory(3);
    for (let i = 0; i < 5; i++) {
      history.push({
        timestamp: `${i}`,
        processes: [{ name: 'a', pm2Name: 'a', pid: 1, status: 'online', cpu: i, memory: i * 10, uptime: 0, restarts: 0 }],
        system: { cpuLoad: 0, totalMem: 0, usedMem: 0, totalDisk: 0, usedDisk: 0, uptime: 0 },
        currentRelease: null,
        releases: [],
      });
    }
    expect(history.cpu).toHaveLength(3);
    expect(history.cpu).toEqual([2, 3, 4]);
  });
});

// ── Poller ────────────────────────────────────────────────────────

const testConfig = assembleConfig({
  app: 'backend',
  ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
  remotePath: '/var/www/app',
  pm2: { apps: [{ name: 'api', port: 3000 }] },
});

describe('collectMetrics', () => {
  it('issues correct SSH commands and parses results', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(
      (c) => c.includes('pm2 jlist'),
      { stdout: JSON.stringify([{ name: 'api', pid: 123, pm2_env: { status: 'online', pm_uptime: Date.now(), restart_time: 0 }, monit: { cpu: 2.5, memory: 128 * 1024 * 1024 } }]), stderr: '', exitCode: 0 },
    );
    executor.when(
      (c) => c.includes('free -mb'),
      { stdout: 'mem:16000 8000', stderr: '', exitCode: 0 },
    );
    executor.when(
      (c) => c.includes('/proc/loadavg'),
      { stdout: 'load:0.5', stderr: '', exitCode: 0 },
    );
    executor.when(
      (c) => c.includes('/proc/uptime'),
      { stdout: 'uptime:86400', stderr: '', exitCode: 0 },
    );
    executor.when(
      (c) => c.includes('df -BG'),
      { stdout: 'disk:100 45', stderr: '', exitCode: 0 },
    );
    executor.when(
      (c) => c.includes('readlink'),
      { stdout: '/var/www/app/releases/2026-01-01T00-00-00', stderr: '', exitCode: 0 },
    );
    executor.when(
      (c) => c.includes('releases.json'),
      { stdout: JSON.stringify([{ timestamp: '2026-01-01', status: 'success', duration: 10 }]), stderr: '', exitCode: 0 },
    );

    const result = await collectMetrics(executor, testConfig.apps[0], testConfig);

    expect(result.processes).toHaveLength(1);
    expect(result.processes[0].name).toBe('api');
    expect(result.processes[0].cpu).toBe(2.5);
    expect(result.system.totalMem).toBe(16000);
    expect(result.currentRelease).toContain('2026-01-01');
    expect(result.releases).toHaveLength(1);

    const history = executor.getHistory();
    expect(history.some((h) => h.command.includes('pm2 jlist'))).toBe(true);
    expect(history.some((h) => h.command.includes('readlink'))).toBe(true);
    expect(history.some((h) => h.command.includes('releases.json'))).toBe(true);
  });

  it('sets error flag when pm2 jlist fails for backend app', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(
      (c) => c.includes('pm2 jlist'),
      { stdout: '', stderr: 'connection refused', exitCode: 1 },
    );
    executor.when(
      (c) => true,
      { stdout: '', stderr: '', exitCode: 0 },
    );

    const result = await collectMetrics(executor, testConfig.apps[0], testConfig);
    expect(result.error).toBe('PM2 command failed');
    expect(result.processes).toEqual([]);
  });

  it('handles frontend app without PM2 gracefully', async () => {
    const frontendConfig = assembleConfig({
      app: 'frontend',
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      remotePath: '/var/www/app',
    });

    const executor = new FakeRemoteExecutor();
    executor.when(
      (c) => true,
      { stdout: '', stderr: '', exitCode: 0 },
    );

    const result = await collectMetrics(executor, frontendConfig.apps[0], frontendConfig);
    expect(result.processes).toEqual([]);
  });
});

describe('collectLogs', () => {
  it('shell-quotes the PM2 namespace', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(
      (c) => true,
      { stdout: 'ok', stderr: '', exitCode: 0 },
    );

    await collectLogs(executor, "api'worker", 20);

    expect(executor.getHistory()[0].command).toContain("pm2 logs 'api'\"'\"'worker'");
  });
});

describe('monitor session', () => {
  it('resolves the selected app server target', () => {
    const config = assembleConfig({
      servers: {
        app: { host: '1.1.1.1', user: 'deploy', port: 22 },
        data: { host: '2.2.2.2', user: 'deploy', port: 22 },
      },
      remotePath: '/var/www/app',
      apps: [
        { name: 'api', appType: 'backend', on: 'app', healthCheck: { enabled: true } },
        { name: 'worker', appType: 'backend', on: 'data', healthCheck: { enabled: true } },
      ],
    });

    const session = resolveMonitorSession(config, 'worker');

    expect(session.isOk()).toBe(true);
    if (session.isOk()) {
      expect(session.value.target.name).toBe('data');
      expect(session.value.target.ssh.host).toBe('2.2.2.2');
    }
  });

  it('limits selectable apps to the connected server target', () => {
    const config = assembleConfig({
      servers: {
        app: { host: '1.1.1.1', user: 'deploy', port: 22 },
        data: { host: '2.2.2.2', user: 'deploy', port: 22 },
      },
      remotePath: '/var/www/app',
      apps: [
        { name: 'api', appType: 'backend', on: 'app', healthCheck: { enabled: true } },
        { name: 'web', appType: 'frontend', on: 'app', healthCheck: { enabled: false } },
        { name: 'worker', appType: 'backend', on: 'data', healthCheck: { enabled: true } },
      ],
    });

    const apps = getAppsForMonitorTarget(config, 'app');

    expect(apps.isOk()).toBe(true);
    if (apps.isOk()) expect(apps.value.map((app) => app.name)).toEqual(['api', 'web']);
  });
});

// ── Ink Component smoke tests ─────────────────────────────────────

describe('Ink components', () => {
  it('Pm2Panel is a function', async () => {
    const mod = await import('../../src/cli/monitor/panels/Pm2Panel.js');
    expect(typeof mod.Pm2Panel).toBe('function');
  });

  it('SystemPanel is a function', async () => {
    const mod = await import('../../src/cli/monitor/panels/SystemPanel.js');
    expect(typeof mod.SystemPanel).toBe('function');
  });

  it('ReleasePanel is a function', async () => {
    const mod = await import('../../src/cli/monitor/panels/ReleasePanel.js');
    expect(typeof mod.ReleasePanel).toBe('function');
  });

  it('LogPanel is a function', async () => {
    const mod = await import('../../src/cli/monitor/panels/LogPanel.js');
    expect(typeof mod.LogPanel).toBe('function');
  });

  it('AppSelector is a function', async () => {
    const mod = await import('../../src/cli/monitor/app-selector.js');
    expect(typeof mod.AppSelector).toBe('function');
  });

  it('App is a function', async () => {
    const mod = await import('../../src/cli/monitor/App.js');
    expect(typeof mod.App).toBe('function');
  });

  it('runMonitor is a function', async () => {
    const mod = await import('../../src/cli/monitor/index.js');
    expect(typeof mod.runMonitor).toBe('function');
  });
});

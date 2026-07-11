import { describe, it, expect } from 'vitest';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import { buildSparkline, buildGauge, thresholdColor, statusColor, formatUptime, formatBytes } from '../../src/cli/monitor/charts.js';
import { parsePm2Jlist, parseSystemStats, parseReleaseRecords, parseDeployLock, parseHealthProbe, parseAccessoryStatus, parseCaddyInfo, splitSections, systemCpuPercent, nextHealthFailStreak, MetricsHistory, type ProcessInfo, type SystemInfo } from '../../src/cli/monitor/state.js';
import { buildMonitorCommand, collectMetrics, collectLogs, collectCaddyLogs } from '../../src/cli/monitor/poller.js';
import { restartProcess, rollbackToRelease } from '../../src/cli/monitor/actions.js';
import { logLineColor } from '../../src/cli/monitor/panels/LogPanel.js';
import { assembleConfig } from '../../src/config/assembly.js';
import { getAccessoriesForMonitorTarget, getAppsForMonitorTarget, resolveMonitorSession } from '../../src/cli/monitor/monitor-session.js';

// ── Charts ────────────────────────────────────────────────────────

describe('buildSparkline', () => {
  it('returns no points for empty values', () => {
    expect(buildSparkline([], 5)).toEqual([]);
  });

  it('maps normalized values to spark characters', () => {
    const chars = buildSparkline([0, 50, 100], 3).map((p) => p.char);
    expect(chars).toEqual(['▁', '▅', '█']);
  });

  it('colors points by normalized height', () => {
    const colors = buildSparkline([0, 50, 100], 3).map((p) => p.color);
    expect(colors).toEqual(['green', 'yellow', 'red']);
  });

  it('handles constant values (no range)', () => {
    const points = buildSparkline([10, 10, 10], 3);
    expect(points).toHaveLength(3);
    expect(points.every((p) => p.color === 'green')).toBe(true);
  });

  it('samples down to fit width', () => {
    const values = Array.from({ length: 100 }, (_, i) => i);
    expect(buildSparkline(values, 10)).toHaveLength(10);
  });
});

describe('buildGauge', () => {
  it('renders a full bar for 100%', () => {
    expect(buildGauge(1, 10).bar).toBe('█'.repeat(10));
  });

  it('renders an empty bar for 0%', () => {
    expect(buildGauge(0, 10).bar).toBe('░'.repeat(10));
  });

  it('renders half bar for 50%', () => {
    const filled = [...buildGauge(0.5, 10).bar].filter((c) => c === '█').length;
    expect(filled).toBe(5);
  });

  it('clamps values above 1 and below 0', () => {
    expect(buildGauge(2, 10).bar).toBe('█'.repeat(10));
    expect(buildGauge(-1, 10).bar).toBe('░'.repeat(10));
  });

  it('always emits exactly width characters', () => {
    expect(buildGauge(0.33, 7).bar).toHaveLength(7);
  });
});

describe('thresholdColor', () => {
  it('is green below 60%', () => {
    expect(thresholdColor(0)).toBe('green');
    expect(thresholdColor(0.59)).toBe('green');
  });

  it('is yellow from 60% to 85%', () => {
    expect(thresholdColor(0.6)).toBe('yellow');
    expect(thresholdColor(0.84)).toBe('yellow');
  });

  it('is red at 85% and above', () => {
    expect(thresholdColor(0.85)).toBe('red');
    expect(thresholdColor(1.5)).toBe('red');
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

describe('statusColor', () => {
  it('maps process states to colors', () => {
    expect(statusColor('online')).toBe('green');
    expect(statusColor('stopped')).toBe('yellow');
    expect(statusColor('stopping')).toBe('yellow');
    expect(statusColor('errored')).toBe('red');
    expect(statusColor('launching')).toBe('gray');
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

  it('parses cluster mode details', () => {
    const stdout = JSON.stringify([makePm2Entry('api', {
      pm2_env: { status: 'online', pm_uptime: 1, restart_time: 0, exec_mode: 'cluster_mode', instances: 4, unstable_restarts: 2, node_version: '22.1.0' },
    })]);
    const [process] = parsePm2Jlist(stdout, 'api');
    expect(process.execMode).toBe('cluster');
    expect(process.instances).toBe(4);
    expect(process.unstableRestarts).toBe(2);
    expect(process.nodeVersion).toBe('22.1.0');
  });

  it('parses exit code for errored fork processes', () => {
    const stdout = JSON.stringify([makePm2Entry('api', {
      pm2_env: { status: 'errored', exec_mode: 'fork_mode', exit_code: 1 },
    })]);
    const [process] = parsePm2Jlist(stdout, 'api');
    expect(process.execMode).toBe('fork');
    expect(process.exitCode).toBe(1);
  });

  it('defaults enrichment fields when absent', () => {
    const [process] = parsePm2Jlist(JSON.stringify([makePm2Entry('api')]), 'api');
    expect(process.execMode).toBe('unknown');
    expect(process.instances).toBe(1);
    expect(process.unstableRestarts).toBe(0);
    expect(process.nodeVersion).toBeUndefined();
    expect(process.exitCode).toBeNull();
  });
});

describe('parseHealthProbe', () => {
  it('parses a healthy probe', () => {
    expect(parseHealthProbe('200 34')).toEqual({ status: 'ok', httpCode: 200, responseMs: 34 });
  });

  it('treats redirects as ok', () => {
    expect(parseHealthProbe('302 12')?.status).toBe('ok');
  });

  it('flags error statuses and unreachable apps as failures', () => {
    expect(parseHealthProbe('502 120')).toEqual({ status: 'fail', httpCode: 502, responseMs: 120 });
    expect(parseHealthProbe('000 5')?.status).toBe('fail');
  });

  it('returns null for empty or garbage output', () => {
    expect(parseHealthProbe('')).toBeNull();
    expect(parseHealthProbe('curl: command not found')).toBeNull();
  });
});

describe('nextHealthFailStreak', () => {
  it('increments on a failed probe', () => {
    expect(nextHealthFailStreak(0, { status: 'fail', httpCode: 500, responseMs: 12 })).toBe(1);
    expect(nextHealthFailStreak(2, { status: 'fail', httpCode: 0, responseMs: 2000 })).toBe(3);
  });

  it('resets to zero on a successful probe', () => {
    expect(nextHealthFailStreak(5, { status: 'ok', httpCode: 200, responseMs: 34 })).toBe(0);
  });

  it('keeps the streak untouched when no probe data is present', () => {
    expect(nextHealthFailStreak(2, undefined)).toBe(2);
    expect(nextHealthFailStreak(0, undefined)).toBe(0);
  });
});

describe('logLineColor', () => {
  it('flags error-like lines red', () => {
    expect(logLineColor('TypeError: cannot read foo')).toBe('red');
    expect(logLineColor('[ERROR] connection refused')).toBe('red');
    expect(logLineColor('Unhandled rejection in worker')).toBe('red');
  });

  it('flags warnings yellow', () => {
    expect(logLineColor('WARN memory usage high')).toBe('yellow');
    expect(logLineColor('deprecation warning: crypto')).toBe('yellow');
  });

  it('leaves ordinary lines unstyled', () => {
    expect(logLineColor('GET /health 200 12ms')).toBeUndefined();
    expect(logLineColor('server listening on :3000')).toBeUndefined();
  });

  it('does not false-positive on words that merely contain "error" or "warn"', () => {
    expect(logLineColor('reflection off the mirror')).toBeUndefined();
    expect(logLineColor('forwarning the request to upstream')).toBeUndefined();
  });

  it('reads structured pino/winston string levels', () => {
    expect(logLineColor('{"level":"error","msg":"db down"}')).toBe('red');
    expect(logLineColor('{"level":"fatal","msg":"oom"}')).toBe('red');
    expect(logLineColor('{"level":"warn","msg":"slow query"}')).toBe('yellow');
    expect(logLineColor('{"level":"info","msg":"ready"}')).toBeUndefined();
  });

  it('reads numeric pino levels', () => {
    expect(logLineColor('{"level":50,"msg":"boom"}')).toBe('red');
    expect(logLineColor('{"level":60,"msg":"boom"}')).toBe('red');
    expect(logLineColor('{"level":40,"msg":"careful"}')).toBe('yellow');
    expect(logLineColor('{"level":30,"msg":"ready"}')).toBeUndefined();
  });

  it('falls back to text heuristics for malformed JSON-looking lines', () => {
    expect(logLineColor('{not valid json, but has ERROR in it')).toBe('red');
  });
});

describe('parseAccessoryStatus', () => {
  it('parses docker inspect lines and strips the container prefix', () => {
    const section = [
      '/shipnode-postgres|running|healthy|postgres:16',
      '/shipnode-redis|running|<no value>|redis:7',
    ].join('\n');

    expect(parseAccessoryStatus(section)).toEqual([
      { name: 'postgres', status: 'running', health: 'healthy', image: 'postgres:16' },
      { name: 'redis', status: 'running', health: '-', image: 'redis:7' },
    ]);
  });

  it('returns empty for empty or garbage sections', () => {
    expect(parseAccessoryStatus('')).toEqual([]);
    expect(parseAccessoryStatus('Error: No such object: shipnode-postgres')).toEqual([]);
  });
});

describe('parseCaddyInfo', () => {
  const logLine = (status: number, uri = '/', duration = 0.012) =>
    JSON.stringify({ status, duration, request: { method: 'GET', uri } });

  it('reports caddy service state', () => {
    expect(parseCaddyInfo('active', '').serviceActive).toBe(true);
    expect(parseCaddyInfo('unknown', '').serviceActive).toBe(false);
  });

  it('buckets request statuses and converts duration to ms', () => {
    const log = [logLine(200), logLine(404), logLine(503)].join('\n');
    const info = parseCaddyInfo('active', log);
    expect(info.total).toBe(3);
    expect(info.ok2xx).toBe(1);
    expect(info.err4xx).toBe(1);
    expect(info.err5xx).toBe(1);
    expect(info.recent[0]).toEqual({ status: 200, method: 'GET', uri: '/', ms: 12 });
  });

  it('skips lines that are not caddy JSON', () => {
    const log = ['garbage', logLine(200), '{"broken json'].join('\n');
    const info = parseCaddyInfo('active', log);
    expect(info.total).toBe(1);
  });

  it('keeps only the five most recent requests', () => {
    const log = Array.from({ length: 7 }, (_, i) => logLine(200, `/page-${i}`)).join('\n');
    const info = parseCaddyInfo('active', log);
    expect(info.total).toBe(7);
    expect(info.recent).toHaveLength(5);
    expect(info.recent[4].uri).toBe('/page-6');
  });
});

describe('parseSystemStats', () => {
  it('parses all system fields', () => {
    const stdout = [
      'mem:16000 8000',
      'load:0.5 0.4 0.3',
      'cores:4',
      'uptime:86400',
      'disk:100 45',
    ].join('\n');
    const result = parseSystemStats(stdout);
    expect(result.totalMem).toBe(16000);
    expect(result.usedMem).toBe(8000);
    expect(result.load1).toBe(0.5);
    expect(result.load5).toBe(0.4);
    expect(result.load15).toBe(0.3);
    expect(result.cores).toBe(4);
    expect(result.uptime).toBe(86400);
    expect(result.totalDisk).toBe(100);
    expect(result.usedDisk).toBe(45);
  });

  it('defaults to zero load and one core for missing fields', () => {
    const result = parseSystemStats('');
    expect(result.totalMem).toBe(0);
    expect(result.load1).toBe(0);
    expect(result.cores).toBe(1);
  });
});

describe('systemCpuPercent', () => {
  const base: SystemInfo = { load1: 0, load5: 0, load15: 0, cores: 1, totalMem: 0, usedMem: 0, totalDisk: 0, usedDisk: 0, uptime: 0 };

  it('normalises load by core count', () => {
    expect(systemCpuPercent({ ...base, load1: 2, cores: 4 })).toBe(0.5);
  });

  it('clamps to 1 when load exceeds core count', () => {
    expect(systemCpuPercent({ ...base, load1: 8, cores: 4 })).toBe(1);
  });

  it('treats zero cores as a single core', () => {
    expect(systemCpuPercent({ ...base, load1: 0.5, cores: 0 })).toBe(0.5);
  });
});

describe('splitSections', () => {
  it('splits delimited output into named sections', () => {
    const stdout = [
      '@@SHIPNODE:pm2@@',
      '[]',
      '@@SHIPNODE:sys@@',
      'mem:16000 8000',
      'load:0.5 0.4 0.3',
      '@@SHIPNODE:current@@',
      '/var/www/app/api/releases/x',
    ].join('\n');

    const sections = splitSections(stdout);

    expect(sections.get('pm2')).toBe('[]');
    expect(sections.get('sys')).toBe('mem:16000 8000\nload:0.5 0.4 0.3');
    expect(sections.get('current')).toBe('/var/www/app/api/releases/x');
  });

  it('ignores output before the first marker', () => {
    const sections = splitSections('mise warning\n@@SHIPNODE:pm2@@\n[]');
    expect(sections.size).toBe(1);
    expect(sections.get('pm2')).toBe('[]');
  });

  it('keeps empty sections as empty strings', () => {
    const sections = splitSections('@@SHIPNODE:pm2@@\n@@SHIPNODE:sys@@\nload:0.5 0.4 0.3');
    expect(sections.get('pm2')).toBe('');
    expect(sections.get('sys')).toBe('load:0.5 0.4 0.3');
  });

  it('returns an empty map for undelimited output', () => {
    expect(splitSections('random garbage').size).toBe(0);
    expect(splitSections('').size).toBe(0);
  });
});

describe('parseDeployLock', () => {
  it('parses timestamp and age', () => {
    const result = parseDeployLock('2026-07-11T10:00:00Z 42');
    expect(result).toEqual({ lockedAt: '2026-07-11T10:00:00Z', ageSeconds: 42 });
  });

  it('returns null when unlocked', () => {
    expect(parseDeployLock('none')).toBeNull();
    expect(parseDeployLock('')).toBeNull();
  });

  it('returns null for garbage', () => {
    expect(parseDeployLock('not a lock line')).toBeNull();
  });

  it('handles an empty lock file with a valid age', () => {
    expect(parseDeployLock(' 42')).toEqual({ lockedAt: '', ageSeconds: 42 });
  });

  it('clamps negative ages to zero', () => {
    expect(parseDeployLock('2026-07-11T10:00:00Z -5')).toEqual({ lockedAt: '2026-07-11T10:00:00Z', ageSeconds: 0 });
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

const emptySystem: SystemInfo = { load1: 0, load5: 0, load15: 0, cores: 1, totalMem: 0, usedMem: 0, totalDisk: 0, usedDisk: 0, uptime: 0 };

function makeProcess(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    name: 'a',
    pm2Name: 'a',
    pid: 1,
    status: 'online',
    cpu: 0,
    memory: 0,
    uptime: 0,
    restarts: 0,
    execMode: 'fork',
    instances: 1,
    unstableRestarts: 0,
    exitCode: null,
    ...overrides,
  };
}

describe('MetricsHistory', () => {
  it('pushes CPU and memory averages', () => {
    const history = new MetricsHistory(5);
    history.push({
      timestamp: 'now',
      processes: [
        makeProcess({ cpu: 10, memory: 100 }),
        makeProcess({ name: 'b', pm2Name: 'b', pid: 2, cpu: 20, memory: 200 }),
      ],
      system: emptySystem,
      currentRelease: null,
      releases: [],
      deployLock: null,
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
        processes: [makeProcess({ cpu: i, memory: i * 10 })],
        system: emptySystem,
        currentRelease: null,
        releases: [],
        deployLock: null,
      });
    }
    expect(history.cpu).toHaveLength(3);
    expect(history.cpu).toEqual([2, 3, 4]);
  });

  it('records response times only when a health probe is present', () => {
    const history = new MetricsHistory(5);
    const base = { timestamp: 'now', processes: [], system: emptySystem, currentRelease: null, releases: [], deployLock: null };

    history.push(base);
    expect(history.responseMs).toHaveLength(0);

    history.push({ ...base, health: { status: 'ok' as const, httpCode: 200, responseMs: 34 } });
    expect(history.responseMs).toEqual([34]);
  });
});

// ── Poller ────────────────────────────────────────────────────────

const testConfig = assembleConfig({
  app: 'backend',
  ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
  remotePath: '/var/www/app',
  pm2: { apps: [{ name: 'api', port: 3000 }] },
});

function sectioned(sections: Record<string, string>): string {
  return Object.entries(sections)
    .map(([name, body]) => `@@SHIPNODE:${name}@@\n${body}`)
    .join('\n');
}

describe('buildMonitorCommand', () => {
  it('emits every section marker', () => {
    const command = buildMonitorCommand(testConfig.apps[0], testConfig);
    for (const name of ['pm2', 'sys', 'current', 'releases', 'lock']) {
      expect(command).toContain(`@@SHIPNODE:${name}@@`);
    }
  });

  it('joins sections with ; so one failure cannot blank the rest', () => {
    const command = buildMonitorCommand(testConfig.apps[0], testConfig);
    expect(command).not.toContain('&&');
  });

  it('gives pm2 a failure sentinel fallback for backend apps', () => {
    const command = buildMonitorCommand(testConfig.apps[0], testConfig);
    expect(command).toContain('pm2 jlist 2>/dev/null || echo "##SHIPNODE_PM2_FAILED##"');
  });

  it('skips pm2 for frontend apps', () => {
    const frontendConfig = assembleConfig({
      app: 'frontend',
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      remotePath: '/var/www/app',
    });
    const command = buildMonitorCommand(frontendConfig.apps[0], frontendConfig);
    expect(command).not.toContain('pm2 jlist');
  });

  it('reads the workspace-level deploy lock', () => {
    const command = buildMonitorCommand(testConfig.apps[0], testConfig);
    expect(command).toContain('/var/www/app/.shipnode/deploy.lock');
  });

  it('collects core count and all three load averages', () => {
    const command = buildMonitorCommand(testConfig.apps[0], testConfig);
    expect(command).toContain('nproc');
    expect(command).toContain(`awk '{print $1, $2, $3}' /proc/loadavg`);
  });

  it('probes the health endpoint capped to the poll interval', () => {
    const command = buildMonitorCommand(testConfig.apps[0], testConfig, { healthMaxTimeSeconds: 2 });
    expect(command).toContain('@@SHIPNODE:health@@');
    expect(command).toContain('http://localhost:3000/health');
    expect(command).toContain('--max-time 2');
  });

  it('omits the health probe when the health check is disabled', () => {
    const config = assembleConfig({
      app: 'backend',
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      remotePath: '/var/www/app',
      pm2: { apps: [{ name: 'api', port: 3000 }] },
      healthCheck: { enabled: false },
    });
    expect(buildMonitorCommand(config.apps[0], config)).not.toContain('@@SHIPNODE:health@@');
  });

  it('omits the health probe when no pm2 app declares a port', () => {
    const config = assembleConfig({
      app: 'backend',
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      remotePath: '/var/www/app',
      pm2: { apps: [{ name: 'worker' }] },
    });
    expect(buildMonitorCommand(config.apps[0], config)).not.toContain('@@SHIPNODE:health@@');
  });

  it('samples accessories with sudo -n docker inspect', () => {
    const command = buildMonitorCommand(testConfig.apps[0], testConfig, { accessoryNames: ['postgres', 'redis'] });
    expect(command).toContain('@@SHIPNODE:accessories@@');
    expect(command).toContain('sudo -n docker inspect');
    expect(command).not.toContain('sudo docker inspect');
    expect(command).toContain(`'shipnode-postgres' 'shipnode-redis'`);
  });

  it('omits the accessories section when no names are given', () => {
    const command = buildMonitorCommand(testConfig.apps[0], testConfig);
    expect(command).not.toContain('@@SHIPNODE:accessories@@');
  });

  it('adds caddy sections for frontend apps only', () => {
    const frontendConfig = assembleConfig({
      app: 'frontend',
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      remotePath: '/var/www/app',
    });
    const frontendApp = frontendConfig.apps[0];
    const command = buildMonitorCommand(frontendApp, frontendConfig);
    expect(command).toContain('@@SHIPNODE:caddy-status@@');
    expect(command).toContain('systemctl is-active caddy');
    expect(command).toContain(`/var/log/caddy/${frontendApp.name}.log`);

    expect(buildMonitorCommand(testConfig.apps[0], testConfig)).not.toContain('caddy');
  });
});

describe('collectMetrics', () => {
  const fullStdout = sectioned({
    pm2: JSON.stringify([{ name: 'api', pid: 123, pm2_env: { status: 'online', pm_uptime: Date.now(), restart_time: 0 }, monit: { cpu: 2.5, memory: 128 * 1024 * 1024 } }]),
    sys: ['mem:16000 8000', 'load:0.5 0.4 0.3', 'cores:2', 'uptime:86400', 'disk:100 45'].join('\n'),
    current: '/var/www/app/releases/2026-01-01T00-00-00',
    releases: JSON.stringify([{ timestamp: '2026-01-01', status: 'success', duration: 10 }]),
    lock: 'none',
  });

  it('collects the full snapshot in a single SSH round trip', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when((c) => c.includes('@@SHIPNODE:pm2@@'), { stdout: fullStdout, stderr: '', exitCode: 0 });

    const result = await collectMetrics(executor, testConfig.apps[0], testConfig);

    expect(result.processes).toHaveLength(1);
    expect(result.processes[0].name).toBe('api');
    expect(result.processes[0].cpu).toBe(2.5);
    expect(result.system.totalMem).toBe(16000);
    expect(result.system.cores).toBe(2);
    expect(result.system.load15).toBe(0.3);
    expect(result.currentRelease).toContain('2026-01-01');
    expect(result.releases).toHaveLength(1);
    expect(result.deployLock).toBeNull();
    expect(result.error).toBeUndefined();

    expect(executor.getHistory()).toHaveLength(1);
  });

  it('derives the SSH timeout from the poll interval', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(() => true, { stdout: fullStdout, stderr: '', exitCode: 0 });

    await collectMetrics(executor, testConfig.apps[0], testConfig, { intervalSeconds: 2 });

    expect(executor.getHistory()[0].options?.timeout).toBe(6000);
  });

  it('parses health and accessories sections when present', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(() => true, {
      stdout: sectioned({
        pm2: '[]',
        lock: 'none',
        health: '200 34',
        accessories: '/shipnode-postgres|running|healthy|postgres:16',
      }),
      stderr: '',
      exitCode: 0,
    });

    const result = await collectMetrics(executor, testConfig.apps[0], testConfig, { accessoryNames: ['postgres'] });

    expect(result.health).toEqual({ status: 'ok', httpCode: 200, responseMs: 34 });
    expect(result.accessories).toEqual([
      { name: 'postgres', status: 'running', health: 'healthy', image: 'postgres:16' },
    ]);
  });

  it('leaves accessories undefined on polls that skip the section', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(() => true, { stdout: fullStdout, stderr: '', exitCode: 0 });

    const result = await collectMetrics(executor, testConfig.apps[0], testConfig);
    expect(result.accessories).toBeUndefined();
  });

  it('reports an active deploy lock', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(() => true, {
      stdout: sectioned({ pm2: '[]', lock: '2026-07-11T10:00:00Z 42' }),
      stderr: '',
      exitCode: 0,
    });

    const result = await collectMetrics(executor, testConfig.apps[0], testConfig);
    expect(result.deployLock).toEqual({ lockedAt: '2026-07-11T10:00:00Z', ageSeconds: 42 });
  });

  it('sets error flag when pm2 jlist fails for backend app', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(() => true, {
      stdout: sectioned({ pm2: '##SHIPNODE_PM2_FAILED##', lock: 'none' }),
      stderr: '',
      exitCode: 0,
    });

    const result = await collectMetrics(executor, testConfig.apps[0], testConfig);
    expect(result.error).toBe('PM2 command failed');
    expect(result.processes).toEqual([]);
  });

  it('sets error flag when the poll returns no sections at all', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(() => true, { stdout: '', stderr: '', exitCode: 1 });

    const result = await collectMetrics(executor, testConfig.apps[0], testConfig);
    expect(result.error).toBe('Monitor poll returned no data');
  });

  it('handles frontend app without PM2 gracefully', async () => {
    const frontendConfig = assembleConfig({
      app: 'frontend',
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      remotePath: '/var/www/app',
    });

    const executor = new FakeRemoteExecutor();
    executor.when(() => true, {
      stdout: sectioned({ pm2: '[]', lock: 'none' }),
      stderr: '',
      exitCode: 0,
    });

    const result = await collectMetrics(executor, frontendConfig.apps[0], frontendConfig);
    expect(result.processes).toEqual([]);
    expect(result.error).toBeUndefined();
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

  it('tails a single process when given an exact pm2 name', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(() => true, { stdout: 'ok', stderr: '', exitCode: 0 });

    await collectLogs(executor, 'api-worker', 20);

    expect(executor.getHistory()[0].command).toContain("pm2 logs 'api-worker' --lines 20");
  });
});

describe('collectCaddyLogs', () => {
  it('tails the caddy access log with a non-interactive sudo fallback', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(() => true, { stdout: '{}', stderr: '', exitCode: 0 });

    await collectCaddyLogs(executor, 'web', 50);

    const command = executor.getHistory()[0].command;
    expect(command).toContain('sudo -n tail -n 50 "/var/log/caddy/web.log"');
    expect(command).toContain('|| tail -n 50 "/var/log/caddy/web.log"');
    expect(command).not.toContain('sudo tail');
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

  it('limits accessories to the connected server target', () => {
    const config = assembleConfig({
      servers: {
        app: { host: '1.1.1.1', user: 'deploy', port: 22 },
        data: { host: '2.2.2.2', user: 'deploy', port: 22 },
      },
      remotePath: '/var/www/app',
      apps: [
        { name: 'api', appType: 'backend', on: 'app', healthCheck: { enabled: true } },
      ],
      accessories: {
        postgres: { image: 'postgres:16', on: 'data' },
        redis: { image: 'redis:7', on: 'app' },
      },
    });

    const names = getAccessoriesForMonitorTarget(config, 'data');

    expect(names.isOk()).toBe(true);
    if (names.isOk()) expect(names.value).toEqual(['postgres']);
  });
});

// ── Actions ───────────────────────────────────────────────────────

describe('restartProcess', () => {
  it('restarts exactly the given pm2 process with env refresh', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(() => true, { stdout: 'ok', stderr: '', exitCode: 0 });

    const result = await restartProcess(executor, "api'worker");

    expect(result.isOk()).toBe(true);
    const command = executor.getHistory()[0].command;
    expect(command).toContain('mise/shims');
    expect(command).toContain(`pm2 restart 'api'"'"'worker' --update-env`);
    expect(executor.getHistory()).toHaveLength(1);
  });

  it('returns a typed error when the restart fails', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(() => true, { stdout: '', stderr: 'process not found', exitCode: 1 });

    const result = await restartProcess(executor, 'api-worker');

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe('ProcessRestartError');
      expect(result.error.pm2Name).toBe('api-worker');
      expect(result.error.message).toContain('process not found');
    }
  });
});

describe('rollbackToRelease', () => {
  const app = testConfig.apps[0];

  it('checks the release exists, switches the symlink atomically, then reloads PM2', async () => {
    const executor = new FakeRemoteExecutor();

    const result = await rollbackToRelease(executor, testConfig, app, '2024-06-01T12-00-00');

    expect(result.isOk()).toBe(true);
    const commands = executor.getHistory().map((entry) => entry.command);
    expect(commands).toHaveLength(3);
    expect(commands[0]).toContain(`[ -d '/var/www/app/${app.name}/releases/2024-06-01T12-00-00' ]`);
    expect(commands[1]).toContain('ln -sfn');
    expect(commands[1]).toContain('mv -Tf');
    expect(commands[1]).toContain(`/var/www/app/${app.name}/current`);
    expect(commands[2]).toContain('pm2 reload');
    expect(commands[2]).toContain('current/ecosystem.config.cjs');
    expect(commands[2]).toContain('--update-env');
  });

  it('fails without touching the symlink when the release directory is missing', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when(() => true, { stdout: '', stderr: '', exitCode: 1 });

    const result = await rollbackToRelease(executor, testConfig, app, '2024-06-01T12-00-00');

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe('ReleaseRollbackError');
      expect(result.error.message).toContain('release directory not found');
    }
    expect(executor.getHistory()).toHaveLength(1);
  });

  it('skips the PM2 reload for frontend apps', async () => {
    const frontendConfig = assembleConfig({
      app: 'frontend',
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      remotePath: '/var/www/app',
    });
    const executor = new FakeRemoteExecutor();

    const result = await rollbackToRelease(executor, frontendConfig, frontendConfig.apps[0], '2024-06-01T12-00-00');

    expect(result.isOk()).toBe(true);
    const commands = executor.getHistory().map((entry) => entry.command);
    expect(commands).toHaveLength(2);
    expect(commands.some((command) => command.includes('pm2'))).toBe(false);
  });

  it('reports a typed error when the symlink switched but PM2 reload failed', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when((command) => command.includes('pm2 reload'), { stdout: '', stderr: 'reload boom', exitCode: 1 });

    const result = await rollbackToRelease(executor, testConfig, app, '2024-06-01T12-00-00');

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain('PM2 reload failed');
      expect(result.error.message).toContain('reload boom');
    }
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

  it('AccessoriesPanel is a function', async () => {
    const mod = await import('../../src/cli/monitor/panels/AccessoriesPanel.js');
    expect(typeof mod.AccessoriesPanel).toBe('function');
  });

  it('StaticFrontendPanel is a function', async () => {
    const mod = await import('../../src/cli/monitor/panels/StaticFrontendPanel.js');
    expect(typeof mod.StaticFrontendPanel).toBe('function');
  });

  it('HelpOverlay is a function', async () => {
    const mod = await import('../../src/cli/monitor/components/HelpOverlay.js');
    expect(typeof mod.HelpOverlay).toBe('function');
  });

  it('ConfirmDialog is a function', async () => {
    const mod = await import('../../src/cli/monitor/components/ConfirmDialog.js');
    expect(typeof mod.ConfirmDialog).toBe('function');
  });

  it('Gauge and Sparkline are functions', async () => {
    const mod = await import('../../src/cli/monitor/components/charts.js');
    expect(typeof mod.Gauge).toBe('function');
    expect(typeof mod.Sparkline).toBe('function');
  });
});

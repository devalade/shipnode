import { describe, it, expect } from 'vitest';
import {
  detectLevel,
  isContinuation,
  LineAssembler,
  parsePm2Line,
  ReplayGuard,
  type LogLine,
} from '../../src/domain/observe/log-line.js';
import {
  applyLogFilter,
  compileQuery,
  countLevels,
  cycleMinLevel,
  cycleOption,
  EMPTY_LOG_FILTER,
  isFiltering,
  logFacets,
  type LogFilter,
} from '../../src/domain/observe/log-filter.js';
import {
  caddyFollowCommand,
  journalFollowCommand,
  planLogSources,
  pm2FollowCommand,
} from '../../src/domain/observe/log-source.js';
import { LogStream, type LogBinding } from '../../src/services/observe/log-stream.js';
import { RemoteExecutor, type ExecOptions } from '../../src/domain/remote/executor.js';
import type { ExecResult, ShipnodeApp } from '../../src/shared/types.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';

function line(partial: Partial<LogLine> & { id: number }): LogLine {
  return {
    at: partial.id,
    server: 'a',
    app: 'api',
    process: 'web',
    levelKnown: true,
    level: 'info',
    text: `line ${partial.id}`,
    ...partial,
  };
}

// ── Classification and parsing ────────────────────────────────────

describe('detectLevel', () => {
  it('reads structured and plain levels', () => {
    expect(detectLevel('{"level":"error","msg":"x"}')).toBe('error');
    expect(detectLevel('{"level":40,"msg":"x"}')).toBe('warn');
    expect(detectLevel('{"level":30,"msg":"x"}')).toBe('info');
    expect(detectLevel('{"level":20,"msg":"x"}')).toBe('debug');
    expect(detectLevel('[ERROR] connection refused')).toBe('error');
    expect(detectLevel('WARN memory high')).toBe('warn');
  });

  it('returns undefined for lines that announce nothing', () => {
    expect(detectLevel('GET /health 200 12ms')).toBeUndefined();
    expect(detectLevel('reflection off the mirror')).toBeUndefined();
  });

  it('grades a Caddy access log line by its status', () => {
    const access = (status: number) => JSON.stringify({ level: 'info', status, request: { uri: '/' } });
    expect(detectLevel(access(200))).toBe('info');
    expect(detectLevel(access(404))).toBe('warn');
    expect(detectLevel(access(502))).toBe('error');
  });

  it('treats stack frames as continuations', () => {
    expect(isContinuation('    at Object.<anonymous> (/app/x.js:1:1)')).toBe(true);
    expect(isContinuation('GET /at 200')).toBe(false);
  });
});

describe('parsePm2Line', () => {
  it('splits the process prefix from the message', () => {
    expect(parsePm2Line('0|api-web  | listening on :3000')).toEqual({ process: 'api-web', text: 'listening on :3000' });
  });

  it('strips colour codes', () => {
    expect(parsePm2Line('1|worker | \u001b[31mboom\u001b[0m')).toEqual({ process: 'worker', text: 'boom' });
  });

  it('drops the per-file banner and keeps unprefixed notices', () => {
    expect(parsePm2Line('/home/deploy/.pm2/logs/api-web-out.log last 20 lines:')).toBeNull();
    expect(parsePm2Line('[TAILING] Tailing last 20 lines')).toEqual({
      process: null,
      text: '[TAILING] Tailing last 20 lines',
    });
  });
});

describe('LineAssembler', () => {
  it('holds a partial line until its newline arrives', () => {
    const assembler = new LineAssembler();
    expect(assembler.push('hel')).toEqual([]);
    expect(assembler.push('lo\nwor')).toEqual(['hello']);
    expect(assembler.push('ld\n')).toEqual(['world']);
  });

  it('drops CR from pty line endings and blank lines, and flushes the tail', () => {
    const assembler = new LineAssembler();
    expect(assembler.push('a\r\n\r\nb\r\nc')).toEqual(['a', 'b']);
    expect(assembler.flush()).toEqual(['c']);
    expect(assembler.flush()).toEqual([]);
  });
});

describe('ReplayGuard', () => {
  it('shows everything until armed', () => {
    const guard = new ReplayGuard();
    expect(['a', 'b'].map((t) => guard.accept(t))).toEqual([true, true]);
  });

  it('swallows a replayed backlog and passes what follows it', () => {
    const guard = new ReplayGuard();
    ['a', 'b', 'c'].forEach((t) => guard.accept(t));
    guard.arm();
    // The server replays its last 2 lines, then something new happens.
    expect(['b', 'c', 'd', 'e'].map((t) => guard.accept(t))).toEqual([false, false, true, true]);
  });

  it('shows everything when the replay shares nothing with what was seen', () => {
    const guard = new ReplayGuard();
    guard.accept('a');
    guard.arm();
    expect(['x', 'y'].map((t) => guard.accept(t))).toEqual([true, true]);
  });

  it('does not swallow a genuine repeat after the replay ends', () => {
    const guard = new ReplayGuard();
    ['a', 'b'].forEach((t) => guard.accept(t));
    guard.arm();
    expect(['b', 'new', 'b'].map((t) => guard.accept(t))).toEqual([false, true, true]);
  });
});

// ── Filtering ─────────────────────────────────────────────────────

describe('compileQuery', () => {
  it('matches plain text case-insensitively', () => {
    const { matcher } = compileQuery('Timeout');
    expect(matcher?.('request TIMEOUT after 5s')).toBe(true);
    expect(matcher?.('all good')).toBe(false);
  });

  it('treats /x/ as a regex, with an optional i flag', () => {
    expect(compileQuery('/^GET \\/api/').matcher?.('GET /api/users')).toBe(true);
    expect(compileQuery('/^GET \\/api/').matcher?.('get /api/users')).toBe(false);
    expect(compileQuery('/^GET \\/api/i').matcher?.('get /api/users')).toBe(true);
  });

  it('negates with a leading !', () => {
    const { matcher } = compileQuery('!health');
    expect(matcher?.('GET /health')).toBe(false);
    expect(matcher?.('GET /users')).toBe(true);
  });

  it('reports a broken regex instead of throwing', () => {
    const result = compileQuery('/(unclosed/');
    expect(result.matcher).toBeNull();
    expect(result.error).toBeDefined();
  });

  it('means "no query" for an empty string or a lone !', () => {
    expect(compileQuery('').matcher).toBeNull();
    expect(compileQuery('!').matcher?.('!')).toBe(true);
  });
});

describe('applyLogFilter', () => {
  const lines = [
    line({ id: 1, server: 'a', app: 'api', process: 'web', level: 'info', text: 'ready' }),
    line({ id: 2, server: 'b', app: 'api', process: 'web', level: 'error', text: 'db timeout' }),
    line({ id: 3, server: 'b', app: 'site', process: null, level: 'warn', text: 'slow response' }),
    line({ id: 4, server: 'a', app: 'api', process: 'worker', level: 'error', text: 'job failed' }),
  ];
  const ids = (filter: Partial<LogFilter>) =>
    applyLogFilter(lines, { ...EMPTY_LOG_FILTER, ...filter }).lines.map((l) => l.id);

  it('keeps everything with no filter', () => {
    expect(ids({})).toEqual([1, 2, 3, 4]);
  });

  it('narrows by server, app and process', () => {
    expect(ids({ server: 'b' })).toEqual([2, 3]);
    expect(ids({ app: 'api' })).toEqual([1, 2, 4]);
    expect(ids({ server: 'a', app: 'api', process: 'worker' })).toEqual([4]);
  });

  it('shows the chosen level and above', () => {
    expect(ids({ minLevel: 'warn' })).toEqual([2, 3, 4]);
    expect(ids({ minLevel: 'error' })).toEqual([2, 4]);
  });

  it('combines dimensions', () => {
    expect(ids({ server: 'b', minLevel: 'error', query: 'timeout' })).toEqual([2]);
  });

  it('hides non-matching lines in hide mode and keeps them dimmed in dim mode', () => {
    expect(ids({ query: 'fail' })).toEqual([4]);
    const dim = applyLogFilter(lines, { ...EMPTY_LOG_FILTER, query: 'fail', mode: 'dim' });
    expect(dim.lines.map((l) => l.id)).toEqual([1, 2, 3, 4]);
    expect([...dim.matched]).toEqual([4]);
  });

  it('surfaces a query error and ignores the query while it is broken', () => {
    const result = applyLogFilter(lines, { ...EMPTY_LOG_FILTER, query: '/(/' });
    expect(result.queryError).toBeDefined();
    expect(result.lines).toHaveLength(4);
  });
});

describe('countLevels', () => {
  it('counts under every filter but the level, so switching level shows what to expect', () => {
    const lines = [
      line({ id: 1, server: 'a', level: 'error' }),
      line({ id: 2, server: 'a', level: 'warn' }),
      line({ id: 3, server: 'b', level: 'error' }),
    ];
    const counts = countLevels(lines, { ...EMPTY_LOG_FILTER, server: 'a', minLevel: 'error' });
    expect(counts).toEqual({ debug: 0, info: 0, warn: 1, error: 1 });
  });
});

describe('countLevels and stack frames', () => {
  it('counts an exception once, not once per inherited frame', () => {
    const lines = [
      line({ id: 1, level: 'error', levelKnown: true }),
      line({ id: 2, level: 'error', levelKnown: false }),
      line({ id: 3, level: 'error', levelKnown: false }),
    ];
    expect(countLevels(lines, EMPTY_LOG_FILTER).error).toBe(1);
  });
});

describe('cycling', () => {
  it('walks all -> each -> all in both directions', () => {
    expect(cycleOption(['a', 'b'], null, 1)).toBe('a');
    expect(cycleOption(['a', 'b'], 'b', 1)).toBeNull();
    expect(cycleOption(['a', 'b'], null, -1)).toBe('b');
  });

  it('restarts from "all" when the current value is gone', () => {
    expect(cycleOption(['a'], 'gone', 1)).toBe('a');
  });

  it('cycles the level all -> warn -> error -> all', () => {
    expect(cycleMinLevel(null)).toBe('warn');
    expect(cycleMinLevel('warn')).toBe('error');
    expect(cycleMinLevel('error')).toBeNull();
  });

  it('reports whether anything narrows the view', () => {
    expect(isFiltering(EMPTY_LOG_FILTER)).toBe(false);
    expect(isFiltering({ ...EMPTY_LOG_FILTER, query: 'x' })).toBe(true);
    expect(isFiltering({ ...EMPTY_LOG_FILTER, mode: 'dim' })).toBe(false);
  });
});

describe('logFacets', () => {
  const lines = [
    line({ id: 1, server: 'a', app: 'api', process: 'web' }),
    line({ id: 2, server: 'a', app: 'api', process: 'worker' }),
    line({ id: 3, server: 'b', app: 'site', process: null }),
  ];

  it('offers everything seen when nothing is chosen', () => {
    expect(logFacets(lines, { server: null, app: null })).toEqual({
      servers: ['a', 'b'],
      apps: ['api', 'site'],
      processes: ['web', 'worker'],
    });
  });

  it('narrows apps and processes to the chosen server and app', () => {
    expect(logFacets(lines, { server: 'b', app: null })).toEqual({
      servers: ['a', 'b'],
      apps: ['site'],
      processes: [],
    });
    expect(logFacets(lines, { server: 'a', app: 'api' }).processes).toEqual(['web', 'worker']);
  });
});

// ── Sources ───────────────────────────────────────────────────────

describe('follow commands', () => {
  it('follows PM2 with a backlog and no colour, quoting the namespace', () => {
    const command = pm2FollowCommand("api'x", 20);
    expect(command).toContain('pm2 logs');
    expect(command).toContain('--lines 20');
    expect(command).toContain('--no-color');
    expect(command).not.toContain("api'x ");
  });

  it('follows a systemd unit through journalctl -f', () => {
    const command = journalFollowCommand('shipnode-api-web', 20);
    expect(command).toContain('journalctl -u');
    expect(command).toContain('-f');
    expect(command).toContain('-n 20');
  });

  it('follows Caddy across log rotation', () => {
    expect(caddyFollowCommand('site', 20)).toContain('-F');
    expect(caddyFollowCommand('site', 20)).toContain('/var/log/caddy/site.log');
  });
});

describe('planLogSources', () => {
  const backend = {
    name: 'api',
    appType: 'backend',
    pm2: { apps: [{ name: 'api' }, { name: 'worker' }] },
  } as unknown as ShipnodeApp;

  it('gives a PM2 app one stream that tags lines with the server and app', async () => {
    const sources = await planLogSources(new FakeRemoteExecutor(), 'a', '/var/www', backend);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ server: 'a', app: 'api', kind: 'pm2' });
    expect(sources[0].command(20)).toContain("'api'");
  });

  it('follows the access log of a frontend app', async () => {
    const site = { name: 'site', appType: 'frontend' } as unknown as ShipnodeApp;
    const [source] = await planLogSources(new FakeRemoteExecutor(), 'a', '/var/www', site);
    expect(source.kind).toBe('caddy');
    expect(source.parse('{"x":1}')).toEqual({ process: null, text: '{"x":1}' });
  });

  it('gives a watt app one stream per unit', async () => {
    const watt = {
      name: 'api',
      appType: 'backend',
      runtime: 'watt',
      pm2: { apps: [{ name: 'api' }, { name: 'worker' }] },
    } as unknown as ShipnodeApp;
    const sources = await planLogSources(new FakeRemoteExecutor(), 'a', '/var/www', watt);
    expect(sources.map((s) => s.kind)).toEqual(['systemd', 'systemd']);
    expect(sources[0].parse('hello')?.process).toBe('api');
    expect(sources[1].parse('hello')?.process).toBe('api-worker');
  });

  it('has nothing to follow for a backend with no processes', async () => {
    const empty = { name: 'x', appType: 'backend' } as unknown as ShipnodeApp;
    expect(await planLogSources(new FakeRemoteExecutor(), 'a', '/var/www', empty)).toEqual([]);
  });
});

// ── Stream ────────────────────────────────────────────────────────

/** An executor whose commands the test drives by hand, like a remote that streams. */
class StreamingExecutor extends RemoteExecutor {
  commands: string[] = [];
  options: Array<ExecOptions | undefined> = [];
  private sessions: Array<{ emit: (chunk: string) => void; end: (exitCode: number) => void; fail: (e: Error) => void }> = [];

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.commands.push(command);
    this.options.push(options);
    return new Promise<ExecResult>((resolve, reject) => {
      const session = {
        emit: (chunk: string) => options?.onData?.(chunk, 'stdout'),
        end: (exitCode: number) => resolve({ stdout: '', stderr: '', exitCode }),
        fail: (error: Error) => reject(error),
      };
      this.sessions.push(session);
      options?.signal?.addEventListener('abort', () => resolve({ stdout: '', stderr: '', exitCode: 143 }), { once: true });
    });
  }

  session(n: number) {
    return this.sessions[n];
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function makeStream(executors: Record<string, StreamingExecutor>, extra: Partial<ConstructorParameters<typeof LogStream>[0]> = {}) {
  const bindings: LogBinding[] = Object.entries(executors).map(([server, executor]) => ({
    executor,
    source: {
      server,
      app: 'api',
      kind: 'pm2',
      command: (n) => `follow ${server} ${n}`,
      parse: parsePm2Line,
    },
  }));
  return new LogStream({
    bindings,
    flushMs: 1,
    liveAfterMs: 1,
    backoffMs: () => 1,
    ...extra,
  });
}

describe('LogStream', () => {
  it('merges servers into one buffer, tagging each line with its server', async () => {
    const a = new StreamingExecutor();
    const b = new StreamingExecutor();
    const stream = makeStream({ a, b });
    stream.start();
    await tick();

    a.session(0).emit('0|web | hello from a\n');
    b.session(0).emit('0|web | hello from b\n');
    await tick();

    expect(stream.lines().map((l) => [l.server, l.process, l.text])).toEqual([
      ['a', 'web', 'hello from a'],
      ['b', 'web', 'hello from b'],
    ]);
    await stream.stop();
  });

  it('follows over a pty and asks for backlog on connect', async () => {
    const a = new StreamingExecutor();
    const stream = makeStream({ a }, { backlog: 7 });
    stream.start();
    await tick();
    expect(a.commands[0]).toBe('follow a 7');
    expect(a.options[0]?.pty).toBe(true);
    await stream.stop();
  });

  it('reassembles a line split across chunks', async () => {
    const a = new StreamingExecutor();
    const stream = makeStream({ a });
    stream.start();
    await tick();
    a.session(0).emit('0|web | split ');
    a.session(0).emit('line\n');
    await tick();
    expect(stream.lines().map((l) => l.text)).toEqual(['split line']);
    await stream.stop();
  });

  it('classifies levels and lets a stack frame inherit the error above it', async () => {
    const a = new StreamingExecutor();
    const stream = makeStream({ a });
    stream.start();
    await tick();
    a.session(0).emit('0|web | TypeError: boom\n0|web |     at run (/app/x.js:1:1)\n0|web | ready\n');
    await tick();
    expect(stream.lines().map((l) => l.level)).toEqual(['error', 'error', 'info']);
    expect(stream.lines().map((l) => l.levelKnown)).toEqual([true, false, false]);
    await stream.stop();
  });

  it('reconnects after the stream ends, without replaying lines already shown', async () => {
    const a = new StreamingExecutor();
    const stream = makeStream({ a });
    stream.start();
    await tick();

    a.session(0).emit('0|web | one\n0|web | two\n');
    a.session(0).end(255);
    await tick();
    await tick();

    expect(a.commands).toHaveLength(2);
    a.session(1).emit('0|web | one\n0|web | two\n0|web | three\n');
    await tick();

    expect(stream.lines().map((l) => l.text)).toEqual(['one', 'two', 'three']);
    await stream.stop();
  });

  it('reports a failing source as reconnecting with the reason, then live again', async () => {
    const a = new StreamingExecutor();
    const stream = makeStream({ a }, { liveAfterMs: 1000 });
    stream.start();
    await tick();

    a.session(0).fail(new Error('connection reset'));
    await tick();
    expect(stream.health()[0]).toMatchObject({ state: 'reconnecting', error: 'connection reset' });

    await tick();
    a.session(1).emit('0|web | back\n');
    await tick();
    expect(stream.health()[0]).toMatchObject({ state: 'live' });
    expect(stream.health()[0].error).toBeUndefined();
    await stream.stop();
  });

  it('keeps one source failing from silencing the others', async () => {
    const a = new StreamingExecutor();
    const b = new StreamingExecutor();
    const stream = makeStream({ a, b });
    stream.start();
    await tick();
    a.session(0).fail(new Error('down'));
    b.session(0).emit('0|web | still here\n');
    await tick();
    expect(stream.lines().map((l) => l.text)).toEqual(['still here']);
    await stream.stop();
  });

  it('bounds the buffer, dropping the oldest', async () => {
    const a = new StreamingExecutor();
    const stream = makeStream({ a }, { capacity: 3 });
    stream.start();
    await tick();
    a.session(0).emit([1, 2, 3, 4, 5].map((n) => `0|web | m${n}\n`).join(''));
    await tick();
    expect(stream.lines().map((l) => l.text)).toEqual(['m3', 'm4', 'm5']);
    await stream.stop();
  });

  it('stops by aborting every channel and stays stopped', async () => {
    const a = new StreamingExecutor();
    const stream = makeStream({ a });
    stream.start();
    await tick();
    await stream.stop();
    expect(a.options[0]?.signal?.aborted).toBe(true);
    expect(stream.isRunning).toBe(false);
    await tick();
    expect(a.commands).toHaveLength(1);
  });

  it('clear drops the buffer but keeps following', async () => {
    const a = new StreamingExecutor();
    const stream = makeStream({ a });
    stream.start();
    await tick();
    a.session(0).emit('0|web | old\n');
    await tick();
    stream.clear();
    expect(stream.lines()).toEqual([]);
    a.session(0).emit('0|web | new\n');
    await tick();
    expect(stream.lines().map((l) => l.text)).toEqual(['new']);
    await stream.stop();
  });

  it('notifies subscribers in batches rather than per line', async () => {
    const a = new StreamingExecutor();
    const stream = makeStream({ a }, { flushMs: 20 });
    let notifications = 0;
    stream.subscribe(() => {
      notifications += 1;
    });
    stream.start();
    await tick();
    const before = notifications;
    a.session(0).emit(Array.from({ length: 50 }, (_, i) => `0|web | m${i}\n`).join(''));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(notifications - before).toBeLessThanOrEqual(2);
    expect(stream.lines()).toHaveLength(50);
    await stream.stop();
  });
});

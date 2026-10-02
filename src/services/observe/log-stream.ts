import type { RemoteExecutor } from '../../domain/remote/executor.js';
import type { LogSource } from '../../domain/observe/log-source.js';
import {
  detectLevel,
  isContinuation,
  LineAssembler,
  ReplayGuard,
  type LogLevel,
  type LogLine,
} from '../../domain/observe/log-line.js';

export type SourceState = 'connecting' | 'live' | 'reconnecting';

export interface LogBinding {
  executor: RemoteExecutor;
  source: LogSource;
}

/** How one followed source is doing, for the viewer's status line. */
export interface SourceHealth {
  server: string;
  app: string;
  kind: LogSource['kind'];
  state: SourceState;
  /** Why the last attempt ended; cleared once data flows again. */
  error?: string;
}

export interface LogStreamOptions {
  bindings: LogBinding[];
  /** Lines kept across all sources; the oldest fall off first. */
  capacity?: number;
  /** Lines of history requested on every (re)connect. */
  backlog?: number;
  /** A quiet app sends nothing, so a connection that has not failed by now is called live. */
  liveAfterMs?: number;
  /** Coalesce bursts: subscribers are told at most this often. */
  flushMs?: number;
  backoffMs?: (attempt: number) => number;
  /** Called synchronously for every accepted line, before batching - for consumers that print rather than render. */
  onLine?: (line: LogLine) => void;
  now?: () => number;
  /** Injected for tests; must resolve early when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

type Subscriber = () => void;

const DEFAULT_BACKOFF = (attempt: number): number => Math.min(30_000, 1000 * 2 ** attempt);

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Follows every source at once and merges them into one bounded buffer.
 *
 * Streaming is per source and holds one long-lived channel each over the SSH
 * connection the host already has, so adding a server adds no connection.
 * Filtering is deliberately not here: the buffer holds everything and the
 * viewer filters it, which is why changing a filter never reconnects and never
 * loses a line that was only hidden.
 */
export class LogStream {
  private readonly capacity: number;
  private readonly backlog: number;
  private readonly liveAfterMs: number;
  private readonly flushMs: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  private readonly subscribers = new Set<Subscriber>();
  private readonly healths: SourceHealth[];
  private buffer: LogLine[] = [];
  private snapshot: readonly LogLine[] = [];
  private nextId = 1;
  private controller: AbortController | null = null;
  private running: Promise<void>[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: LogStreamOptions) {
    this.capacity = options.capacity ?? 2000;
    this.backlog = options.backlog ?? 20;
    this.liveAfterMs = options.liveAfterMs ?? 1500;
    this.flushMs = options.flushMs ?? 100;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;
    this.healths = options.bindings.map(({ source }) => ({
      server: source.server,
      app: source.app,
      kind: source.kind,
      state: 'connecting',
    }));
  }

  get isRunning(): boolean {
    return this.controller !== null;
  }

  lines(): readonly LogLine[] {
    return this.snapshot;
  }

  health(): readonly SourceHealth[] {
    return this.healths.map((health) => ({ ...health }));
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /** Forget what has been seen. Followed sources keep following. */
  clear(): void {
    this.buffer = [];
    this.snapshot = [];
    this.notify();
  }

  start(): void {
    if (this.controller !== null) return;
    const controller = new AbortController();
    this.controller = controller;
    this.running = this.options.bindings.map((binding, index) => this.follow(binding, index, controller.signal));
  }

  /** Stop following and wait for every channel to close, so nothing is left running remotely. */
  async stop(): Promise<void> {
    const controller = this.controller;
    if (controller === null) return;
    this.controller = null;
    controller.abort();
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await Promise.allSettled(this.running);
    this.running = [];
  }

  private async follow(binding: LogBinding, index: number, signal: AbortSignal): Promise<void> {
    const { executor, source } = binding;
    let assembler = new LineAssembler();
    const guard = new ReplayGuard();
    let lastLevel: LogLevel | undefined;
    let attempt = 0;
    let firstConnect = true;

    const ingest = (raw: string): void => {
      const parsed = source.parse(raw);
      if (parsed === null || parsed.text.trim() === '') return;
      if (!guard.accept(parsed.text)) return;

      const detected = detectLevel(parsed.text);
      // A stack frame continues the error above it rather than reading as info.
      const inherited = detected === undefined && isContinuation(parsed.text) ? lastLevel : undefined;
      if (detected !== undefined) lastLevel = detected;

      this.push({
        id: this.nextId++,
        at: this.now(),
        server: source.server,
        app: source.app,
        process: parsed.process,
        levelKnown: detected !== undefined,
        level: detected ?? inherited ?? 'info',
        text: parsed.text,
      });
    };

    while (!signal.aborted) {
      this.setState(index, firstConnect ? 'connecting' : 'reconnecting');
      if (!firstConnect) guard.arm();
      firstConnect = false;
      // A connection that died mid-line leaves half a line; it must not prefix the next one's first.
      assembler = new LineAssembler();

      let reason: string;
      const liveTimer = setTimeout(() => this.setState(index, 'live'), this.liveAfterMs);
      try {
        const result = await executor.exec(source.command(this.backlog), {
          pty: true,
          signal,
          onData: (chunk) => {
            if (attempt !== 0 || this.healths[index].state !== 'live') {
              attempt = 0;
              this.setState(index, 'live', null);
            }
            for (const line of assembler.push(chunk)) ingest(line);
          },
        });
        for (const line of assembler.flush()) ingest(line);
        reason = `stream ended (exit ${result.exitCode})`;
      } catch (cause: unknown) {
        reason = cause instanceof Error ? cause.message : String(cause);
      } finally {
        clearTimeout(liveTimer);
      }

      if (signal.aborted) break;
      this.setState(index, 'reconnecting', reason);
      await this.sleep(this.backoffMs(attempt), signal);
      attempt += 1;
    }
  }

  private setState(index: number, state: SourceState, error?: string | null): void {
    const health = this.healths[index];
    const nextError = error === undefined ? health.error : (error ?? undefined);
    if (health.state === state && health.error === nextError) return;
    health.state = state;
    health.error = nextError;
    this.schedule();
  }

  private push(line: LogLine): void {
    this.options.onLine?.(line);
    this.buffer.push(line);
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);
    this.schedule();
  }

  private schedule(): void {
    if (this.flushTimer !== null || this.controller === null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.snapshot = this.buffer.slice();
      this.notify();
    }, this.flushMs);
  }

  private notify(): void {
    for (const subscriber of this.subscribers) subscriber();
  }
}

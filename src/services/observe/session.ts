import type { ShipnodeApp } from '../../shared/types.js';
import type { CollectRequest } from '../../domain/observe/collector.js';
import { pivotByApp } from '../../domain/observe/pivot.js';
import type { FleetView, ServerSnapshot } from '../../domain/observe/snapshot.js';
import { nextHealthFailStreak, type HealthInfo } from '../../domain/observe/types.js';
import type { ObserveEvent } from './events.js';
import { MetricsHistory } from './history.js';

/** Sample docker accessory state roughly every this many seconds, not every tick. */
export const ACCESSORY_SAMPLE_SECONDS = 10;

/** Consecutive failed health probes before the session raises an alert. */
export const HEALTH_ALERT_THRESHOLD = 3;

/** SSH connections opened at once. A twelve-host fleet must not open twelve. */
export const MAX_CONCURRENT_POLLS = 4;

/** The collector seam, structurally satisfied by `MetricsCollector`. */
export interface ServerObserver {
  readonly serverName: string;
  collect(request: CollectRequest): Promise<ServerSnapshot>;
}

/** One server to poll, with what lives on it. Resolved by the caller from config. */
export interface ObserveTarget {
  observer: ServerObserver;
  apps: ShipnodeApp[];
  accessoryNames: string[];
}

export interface ObserveState {
  /** The collected truth, one entry per target that has reported, in target order. */
  servers: ServerSnapshot[];
  /** The same tick pivoted by app, where release skew becomes visible. */
  fleets: FleetView[];
  events: ObserveEvent[];
  lastUpdate: string | null;
  polling: boolean;
}

export interface ObserveSessionOptions {
  targets: ObserveTarget[];
  intervalSeconds: number;
  maxEvents?: number;
  /** Injected for tests; defaults to the real clock. */
  now?: () => Date;
}

type Subscriber = (state: ObserveState) => void;

/**
 * Everything stateful about watching a set of servers: scheduling, history,
 * health streaks, and the event log.
 *
 * The collectors below it are stateless and the renderers above it are pure,
 * so this is the only place that has to reason about "since last tick" - which
 * is why the same session can drive a live dashboard, a one-shot snapshot, and
 * `--json` without any of them re-polling.
 */
export class ObserveSession {
  private readonly targets: ObserveTarget[];
  private readonly intervalSeconds: number;
  private readonly maxEvents: number;
  private readonly now: () => Date;

  private readonly histories = new Map<string, MetricsHistory>();
  private readonly healthStreaks = new Map<string, number>();
  private readonly unreachable = new Set<string>();
  private readonly subscribers = new Set<Subscriber>();

  private snapshots = new Map<string, ServerSnapshot>();
  private events: ObserveEvent[] = [];
  private lastUpdate: string | null = null;
  private polling = false;
  private tickCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ObserveSessionOptions) {
    this.targets = options.targets;
    this.intervalSeconds = Math.max(1, options.intervalSeconds);
    this.maxEvents = options.maxEvents ?? 100;
    this.now = options.now ?? (() => new Date());
  }

  /** Sparkline window for one app on one server, created on first sight. */
  history(server: string, app: string): MetricsHistory {
    const key = historyKey(server, app);
    const existing = this.histories.get(key);
    if (existing !== undefined) return existing;
    const created = new MetricsHistory();
    this.histories.set(key, created);
    return created;
  }

  getState(): ObserveState {
    const servers = this.targets.flatMap((target) => {
      const snapshot = this.snapshots.get(target.observer.serverName);
      return snapshot === undefined ? [] : [snapshot];
    });
    return {
      servers,
      fleets: pivotByApp(servers),
      events: this.events,
      lastUpdate: this.lastUpdate,
      polling: this.polling,
    };
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /** Record something the user did, so it lands in the same log as observations. */
  notice(message: string): void {
    this.append({ kind: 'notice', at: this.now().toISOString(), message });
    this.publish();
  }

  start(): void {
    if (this.timer !== null) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalSeconds * 1000);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass over every target.
   *
   * A tick still running when the next is due is skipped rather than
   * overlapped: a slow host would otherwise stack connections until the box
   * refuses them, and a stale reading beats a queue.
   */
  async tick(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.publish();

    const sampleAccessories = this.tickCount % this.accessoryCadence() === 0;
    this.tickCount += 1;

    try {
      await this.forEachTarget(async (target) => {
        const snapshot = await target.observer.collect({
          apps: target.apps,
          intervalSeconds: this.intervalSeconds,
          accessoryNames:
            sampleAccessories && target.accessoryNames.length > 0 ? target.accessoryNames : undefined,
        });
        this.absorb(snapshot);
      });
      this.lastUpdate = this.now().toISOString();
    } finally {
      this.polling = false;
      this.publish();
    }
  }

  private accessoryCadence(): number {
    return Math.max(1, Math.ceil(ACCESSORY_SAMPLE_SECONDS / this.intervalSeconds));
  }

  /** Bounded-parallel fan-out: at most MAX_CONCURRENT_POLLS connections live at once. */
  private async forEachTarget(visit: (target: ObserveTarget) => Promise<void>): Promise<void> {
    const queue = [...this.targets];
    const width = Math.min(MAX_CONCURRENT_POLLS, queue.length);
    const workers = Array.from({ length: width }, async () => {
      for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
        await visit(target);
      }
    });
    await Promise.all(workers);
  }

  private absorb(snapshot: ServerSnapshot): void {
    const at = this.now().toISOString();
    const server = snapshot.server;

    // A skipped accessories section means "not sampled this tick", not "none
    // left" - carrying the previous value forward keeps the panel from blinking.
    const previous = this.snapshots.get(server);
    const merged =
      snapshot.accessories === undefined && previous?.accessories !== undefined
        ? { ...snapshot, accessories: previous.accessories }
        : snapshot;
    this.snapshots.set(server, merged);

    if (merged.error !== undefined) {
      // Report the crossing, not every tick the host stays down.
      if (!this.unreachable.has(server)) {
        this.unreachable.add(server);
        this.append({ kind: 'server-unreachable', at, server, message: merged.error });
      }
      return;
    }
    if (this.unreachable.delete(server)) {
      this.append({ kind: 'server-recovered', at, server });
    }

    for (const app of merged.apps) {
      this.history(server, app.app).push(app);
      if (app.error !== undefined) {
        this.append({ kind: 'app-error', at, server, app: app.app, message: app.error });
      }
      this.trackHealth(at, server, app.app, app.health);
    }
  }

  private trackHealth(at: string, server: string, app: string, health: HealthInfo | undefined): void {
    const key = historyKey(server, app);
    const previous = this.healthStreaks.get(key) ?? 0;
    const streak = nextHealthFailStreak(previous, health);
    this.healthStreaks.set(key, streak);

    if (streak === HEALTH_ALERT_THRESHOLD && previous < HEALTH_ALERT_THRESHOLD) {
      this.append({ kind: 'health-failing', at, server, app, streak });
    }
    if (streak === 0 && previous >= HEALTH_ALERT_THRESHOLD) {
      this.append({ kind: 'health-recovered', at, server, app });
    }
  }

  /** Consecutive failed probes for one app on one server. */
  healthFailStreak(server: string, app: string): number {
    return this.healthStreaks.get(historyKey(server, app)) ?? 0;
  }

  private append(event: ObserveEvent): void {
    this.events = [...this.events.slice(-(this.maxEvents - 1)), event];
  }

  private publish(): void {
    const state = this.getState();
    for (const subscriber of this.subscribers) subscriber(state);
  }
}

/**
 * App names are free-form, so the two halves are joined on NUL - a printable
 * separator would let ("a b", "c") and ("a", "b c") collide into one history
 * window.
 */
function historyKey(server: string, app: string): string {
  return `${server} ${app}`;
}

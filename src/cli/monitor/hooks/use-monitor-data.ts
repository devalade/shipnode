import { useEffect, useRef, useState } from 'react';
import { useStdout } from 'ink';
import chalk from 'chalk';
import type { RemoteExecutor } from '../../../domain/remote/executor.js';
import type { ShipnodeApp, ShipnodeConfig } from '../../../shared/types.js';
import { collectMetrics } from '../poller.js';
import { MetricsHistory, nextHealthFailStreak, type MetricsSnapshot } from '../state.js';

/** Sample docker accessory state roughly every this many seconds, not every poll. */
const ACCESSORY_SAMPLE_SECONDS = 10;

/** Consecutive failed health probes before the monitor raises an alert. */
export const HEALTH_ALERT_THRESHOLD = 3;

export interface MonitorDataState {
  snapshot: MetricsSnapshot | null;
  history: MetricsHistory;
  events: string[];
  error: string | null;
  lastUpdate: string;
  polling: boolean;
  /** Consecutive failed health probes; >= HEALTH_ALERT_THRESHOLD means alerting. */
  healthFailStreak: number;
  refresh: () => Promise<void>;
  appendEvent: (message: string) => void;
  reset: () => void;
}

export function useMonitorData(
  executor: RemoteExecutor,
  config: ShipnodeConfig,
  app: ShipnodeApp,
  interval: number,
  accessoryNames: string[] = [],
): MonitorDataState {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState('');
  const [polling, setPolling] = useState(false);
  const [healthFailStreak, setHealthFailStreak] = useState(0);
  const { stdout } = useStdout();
  const historyRef = useRef(new MetricsHistory());
  const inFlightRef = useRef(false);
  const pollCountRef = useRef(0);
  const healthStreakRef = useRef(0);

  const appendEvent = (message: string): void => {
    setEvents((prev) => [...prev.slice(-100), message]);
  };

  const refresh = async (): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPolling(true);
    try {
      const cadence = Math.max(1, Math.ceil(ACCESSORY_SAMPLE_SECONDS / interval));
      const sampleAccessories = pollCountRef.current % cadence === 0;
      pollCountRef.current += 1;

      const nextSnapshot = await collectMetrics(executor, app, config, {
        intervalSeconds: interval,
        accessoryNames: sampleAccessories ? accessoryNames : undefined,
      });
      setSnapshot((prev) =>
        nextSnapshot.accessories === undefined && prev !== null
          ? { ...nextSnapshot, accessories: prev.accessories }
          : nextSnapshot,
      );
      historyRef.current.push(nextSnapshot);

      const streak = nextHealthFailStreak(healthStreakRef.current, nextSnapshot.health);
      if (streak === HEALTH_ALERT_THRESHOLD && healthStreakRef.current < HEALTH_ALERT_THRESHOLD) {
        appendEvent(chalk.bold.red(`Health check failing (${streak} consecutive probes)`));
        stdout?.write('\x07');
      }
      if (streak === 0 && healthStreakRef.current >= HEALTH_ALERT_THRESHOLD) {
        appendEvent(chalk.green('Health check recovered'));
      }
      healthStreakRef.current = streak;
      setHealthFailStreak(streak);

      setLastUpdate(new Date().toLocaleTimeString());
      setError(nextSnapshot.error ?? null);
      if (nextSnapshot.error) appendEvent(chalk.red(nextSnapshot.error));
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      appendEvent(chalk.red(`Poll failed: ${message}`));
    } finally {
      inFlightRef.current = false;
      setPolling(false);
    }
  };

  const reset = (): void => {
    historyRef.current.clear();
    pollCountRef.current = 0;
    healthStreakRef.current = 0;
    setHealthFailStreak(0);
    setSnapshot(null);
    setError(null);
    setLastUpdate('');
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, interval * 1000);
    return () => clearInterval(timer);
  }, [app, interval]);

  return {
    snapshot,
    history: historyRef.current,
    events,
    error,
    lastUpdate,
    polling,
    healthFailStreak,
    refresh,
    appendEvent,
    reset,
  };
}

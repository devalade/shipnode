import { useEffect, useRef, useState } from 'react';
import chalk from 'chalk';
import type { RemoteExecutor } from '../../../domain/remote/executor.js';
import type { ShipnodeApp, ShipnodeConfig } from '../../../shared/types.js';
import { collectMetrics } from '../poller.js';
import { MetricsHistory, type MetricsSnapshot } from '../state.js';

/** Sample docker accessory state roughly every this many seconds, not every poll. */
const ACCESSORY_SAMPLE_SECONDS = 10;

export interface MonitorDataState {
  snapshot: MetricsSnapshot | null;
  history: MetricsHistory;
  events: string[];
  error: string | null;
  lastUpdate: string;
  polling: boolean;
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
  const historyRef = useRef(new MetricsHistory());
  const inFlightRef = useRef(false);
  const pollCountRef = useRef(0);

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
    refresh,
    appendEvent,
    reset,
  };
}

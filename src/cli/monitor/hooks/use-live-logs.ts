import { useEffect, useRef, useState } from 'react';
import type { RemoteExecutor } from '../../../domain/remote/executor.js';
import type { ShipnodeApp } from '../../../shared/types.js';
import { collectLogs, collectCaddyLogs } from '../poller.js';

const MAX_BUFFER_LINES = 500;

export interface LiveLogsState {
  logBuffer: string;
  clearLogs: () => void;
}

export function useLiveLogs(
  executor: RemoteExecutor,
  app: ShipnodeApp,
  liveMode: boolean,
  interval: number,
  /** Exact pm2 process name to tail, or null for the whole app namespace. */
  filter: string | null = null,
): LiveLogsState {
  const [logBuffer, setLogBuffer] = useState('');
  const lastChunkRef = useRef('');
  const inFlightRef = useRef(false);

  const clearLogs = (): void => {
    lastChunkRef.current = '';
    setLogBuffer('');
  };

  const fetchLogs = async (): Promise<string> => {
    if (app.appType === 'frontend') {
      return collectCaddyLogs(executor, app.name, 50);
    }
    const target = filter ?? app.pm2?.apps[0]?.name;
    if (target === undefined) return '';
    return collectLogs(executor, target, 20);
  };

  const pollLogs = async (): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const freshLogs = await fetchLogs();
      if (!freshLogs || freshLogs === '(no logs)' || freshLogs === lastChunkRef.current) return;
      lastChunkRef.current = freshLogs;
      setLogBuffer((prev) => {
        const combined = prev ? `${prev}\n${freshLogs}` : freshLogs;
        return combined.split('\n').slice(-MAX_BUFFER_LINES).join('\n');
      });
    } finally {
      inFlightRef.current = false;
    }
  };

  useEffect(() => {
    clearLogs();
  }, [app, filter]);

  useEffect(() => {
    if (!liveMode) return;
    void pollLogs();
    const timer = setInterval(() => {
      void pollLogs();
    }, interval * 1000);
    return () => clearInterval(timer);
  }, [liveMode, app, interval, filter]);

  return { logBuffer, clearLogs };
}

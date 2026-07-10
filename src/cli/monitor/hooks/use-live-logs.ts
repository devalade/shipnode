import { useEffect, useRef, useState } from 'react';
import type { RemoteExecutor } from '../../../domain/remote/executor.js';
import type { ShipnodeApp } from '../../../shared/types.js';
import { collectLogs } from '../poller.js';

export interface LiveLogsState {
  logBuffer: string;
  clearLogs: () => void;
}

export function useLiveLogs(
  executor: RemoteExecutor,
  app: ShipnodeApp,
  liveMode: boolean,
  interval: number,
): LiveLogsState {
  const [logBuffer, setLogBuffer] = useState('');
  const lastChunkRef = useRef('');
  const inFlightRef = useRef(false);

  const clearLogs = (): void => {
    lastChunkRef.current = '';
    setLogBuffer('');
  };

  const pollLogs = async (): Promise<void> => {
    if (inFlightRef.current) return;
    const namespace = app.pm2?.apps[0]?.name;
    if (!namespace) return;

    inFlightRef.current = true;
    try {
      const freshLogs = await collectLogs(executor, namespace, 20);
      if (!freshLogs || freshLogs === '(no logs)' || freshLogs === lastChunkRef.current) return;
      lastChunkRef.current = freshLogs;
      setLogBuffer((prev) => {
        const combined = prev ? `${prev}\n${freshLogs}` : freshLogs;
        return combined.split('\n').slice(-80).join('\n');
      });
    } finally {
      inFlightRef.current = false;
    }
  };

  useEffect(() => {
    clearLogs();
  }, [app]);

  useEffect(() => {
    if (!liveMode) return;
    void pollLogs();
    const timer = setInterval(() => {
      void pollLogs();
    }, interval * 1000);
    return () => clearInterval(timer);
  }, [liveMode, app, interval]);

  return { logBuffer, clearLogs };
}

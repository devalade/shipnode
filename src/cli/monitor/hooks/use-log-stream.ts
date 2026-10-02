import { useEffect, useRef, useState } from 'react';
import { planLogSources } from '../../../domain/observe/log-source.js';
import type { LogLine } from '../../../domain/observe/log-line.js';
import { LogStream, type LogBinding, type SourceHealth } from '../../../services/observe/log-stream.js';
import type { FleetHost } from '../../observe.js';

export interface LogStreamData {
  lines: readonly LogLine[];
  health: readonly SourceHealth[];
  /** Total sources being followed; 0 once planning finished with nothing to follow. */
  sources: number;
  /** Servers whose sources could not be planned (host unreachable, units unresolved). */
  skipped: string[];
  clear: () => void;
}

/**
 * Follow every server's logs from the moment they are first wanted.
 *
 * Streaming starts lazily - a dashboard that never opens logs never opens the
 * channels - and then stays on for the rest of the session, so toggling the
 * view off and on does not drop the buffer or replay the backlog.
 */
export function useLogStream(hosts: readonly FleetHost[], wanted: boolean): LogStreamData {
  const streamRef = useRef<LogStream | null>(null);
  const startedRef = useRef(false);
  const [lines, setLines] = useState<readonly LogLine[]>([]);
  const [health, setHealth] = useState<readonly SourceHealth[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);

  useEffect(() => {
    if (!wanted || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;

    void (async () => {
      const bindings: LogBinding[] = [];
      const failed: string[] = [];
      await Promise.all(
        hosts.map(async (host) => {
          if (host.executor === null) {
            failed.push(host.name);
            return;
          }
          for (const app of host.apps) {
            try {
              const sources = await planLogSources(host.executor, host.name, host.config.remotePath, app);
              for (const source of sources) bindings.push({ executor: host.executor, source });
            } catch {
              failed.push(host.name);
            }
          }
        }),
      );
      if (cancelled) return;

      // Promise.all finished in completion order; sort so colours and cycling are stable.
      bindings.sort((a, b) => a.source.server.localeCompare(b.source.server) || a.source.app.localeCompare(b.source.app));
      const stream = new LogStream({ bindings });
      streamRef.current = stream;
      stream.subscribe(() => {
        setLines(stream.lines());
        setHealth(stream.health());
      });
      setSkipped([...new Set(failed)]);
      setHealth(stream.health());
      stream.start();
    })();

    return () => {
      cancelled = true;
    };
  }, [wanted, hosts]);

  // Stop only when the dashboard itself goes away.
  useEffect(
    () => () => {
      void streamRef.current?.stop();
    },
    [],
  );

  return {
    lines,
    health,
    sources: health.length,
    skipped,
    clear: () => streamRef.current?.clear(),
  };
}

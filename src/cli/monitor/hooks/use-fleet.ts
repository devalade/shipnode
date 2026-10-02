import { useEffect, useRef, useState } from 'react';
import { ObserveSession, type ObserveState, type ObserveTarget } from '../../../services/observe/session.js';

export interface FleetData {
  state: ObserveState;
  session: ObserveSession;
  refresh: () => Promise<void>;
}

/**
 * Own one `ObserveSession` for the life of the dashboard and mirror its state
 * into React. The session does the scheduling, history and event detection; this
 * hook only subscribes and renders what it publishes.
 */
export function useFleet(targets: ObserveTarget[], intervalSeconds: number): FleetData {
  const sessionRef = useRef<ObserveSession | null>(null);
  if (sessionRef.current === null) {
    sessionRef.current = new ObserveSession({ targets, intervalSeconds });
  }
  const session = sessionRef.current;
  const [state, setState] = useState<ObserveState>(() => session.getState());

  useEffect(() => {
    const unsubscribe = session.subscribe(setState);
    session.start();
    return () => {
      unsubscribe();
      session.stop();
    };
  }, [session]);

  return { state, session, refresh: () => session.tick() };
}

import { useEffect, useState } from 'react';

/** The current time, re-rendering every `ms` - for "updated 3s ago" and flash expiry. */
export function useNow(ms: number = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

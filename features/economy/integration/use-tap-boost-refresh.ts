"use client";

import { useEffect, useRef } from "react";

/** Refresh after confirmed tap receipts, with one in-flight read and a two-second cadence. */
export function useTapBoostRefresh(owner: string | null, confirmedTaps: number, hasWork: boolean, refresh: () => Promise<unknown>) {
  const taps = useRef(confirmedTaps);
  useEffect(() => { taps.current = confirmedTaps; }, [confirmedTaps]);
  useEffect(() => {
    if (!owner || !hasWork) return;
    let seen = taps.current, reading = false, disposed = false;
    const timer = setInterval(async () => {
      if (disposed || reading || document.hidden || !navigator.onLine || seen === taps.current) return;
      const receipt = taps.current;
      reading = true;
      try {
        await refresh();
        if (!disposed) seen = receipt;
      } catch { /* The next tick retries; the economy session owns visible sync errors. */ }
      finally { reading = false; }
    }, 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [owner, hasWork, refresh]);
}

"use client";

import { useEffect, useRef } from "react";

const REFRESH_CADENCE_MS = 750;

/** Read the first confirmed receipt immediately; coalesce further receipts while
 * keeping one read in flight and at least 750 ms between request starts. */
export function useTapBoostRefresh(owner: string | null, confirmedTaps: number, hasWork: boolean, refresh: () => Promise<boolean>) {
  const latest = useRef({ owner, confirmedTaps, hasWork, refresh });
  const wake = useRef<(() => void) | null>(null);
  useEffect(() => {
    latest.current = { owner, confirmedTaps, hasWork, refresh };
    wake.current?.();
  }, [owner, confirmedTaps, hasWork, refresh]);
  useEffect(() => {
    let currentOwner = latest.current.owner, seen = latest.current.confirmedTaps;
    let generation = 0, reading = false, disposed = false, lastStarted = Number.NEGATIVE_INFINITY;
    let timer: number | null = null;
    const clearTimer = () => { if (timer !== null) window.clearTimeout(timer); timer = null; };
    const check = () => {
      clearTimer();
      if (disposed) return;
      const value = latest.current;
      if (value.owner !== currentOwner || value.confirmedTaps < seen || !value.owner || !value.hasWork) {
        currentOwner = value.owner;
        seen = value.confirmedTaps;
        generation++;
        return;
      }
      if (reading || seen === value.confirmedTaps || document.hidden || !navigator.onLine) return;
      const delay = Math.max(0, lastStarted + REFRESH_CADENCE_MS - performance.now());
      if (delay > 0) { timer = window.setTimeout(check, delay); return; }
      const receipt = value.confirmedTaps, requestGeneration = generation;
      reading = true;
      lastStarted = performance.now();
      void (async () => {
        try {
          const result = await value.refresh();
          if (!disposed && requestGeneration === generation && result === true) seen = receipt;
        } catch { /* A visible pending receipt retries; the session owns sync errors. */ }
        finally { reading = false; if (!disposed) check(); }
      })();
    };
    wake.current = check;
    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", check);
    window.addEventListener("offline", check);
    return () => {
      disposed = true;
      clearTimer();
      wake.current = null;
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("online", check);
      window.removeEventListener("offline", check);
    };
  }, []);
}

"use client";

import { useEffect, useState } from "react";
import { worldCountdown } from "@/features/economy/ui/shared/world-stations";

/** Wake just this label at each server-clock second boundary, including after tab suspension. */
export function BoatCountdown({ until, now, readClock, secondsOnly = false }: {
  until: number; now: number; readClock?: () => number; secondsOnly?: boolean;
}) {
  const [seconds, setSeconds] = useState(() => Math.ceil((until - now) / 1000));
  useEffect(() => {
    if (!readClock) return;
    let timer: number | undefined;
    const sync = () => {
      window.clearTimeout(timer);
      if (document.hidden) return;
      const ms = Math.max(0, until - readClock());
      const left = Math.ceil(ms / 1000);
      setSeconds(left);
      if (left > 0) timer = window.setTimeout(sync, Math.ceil(ms - (left - 1) * 1000));
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [until, readClock]);
  const remaining = Math.max(0, readClock ? seconds : Math.ceil((until - now) / 1000));
  return <time>{secondsOnly ? `${remaining} с` : worldCountdown(remaining)}</time>;
}

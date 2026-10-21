"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/check-in-api";
import { getGuestWorld } from "./guest-world-api";
import type { GuestWorld, GuestWorldTarget } from "./guest-world-model";

type View = { data: GuestWorld | null; error: string | null; loading: boolean; refreshing: boolean };

/** A visit is a live read, never an offline save or an economy owner switch. */
export function useGuestWorld(ownerPublicId: string, target: GuestWorldTarget, onSessionLost?: () => void) {
  const [view, setView] = useState<View>({ data: null, error: null, loading: true, refreshing: false });
  const [refresh, setRefresh] = useState(0);
  const refreshWorld = useCallback(() => setRefresh(value => value + 1), []);
  const [now, setNow] = useState(() => Date.now());
  const clock = useRef<{ server: number; local: number } | null>(null);
  const onLost = useRef(onSessionLost);
  useEffect(() => { onLost.current = onSessionLost; }, [onSessionLost]);
  const { circleId, targetPublicId } = target;

  useEffect(() => {
    let disposed = false, sequence = 0;
    let request: AbortController | null = null;
    const load = () => {
      request?.abort();
      const id = ++sequence;
      if (document.hidden || !navigator.onLine) {
        setView({ data: null, error: navigator.onLine ? null : "Нет сети. Подключитесь, чтобы вернуться в гости.", loading: navigator.onLine, refreshing: false });
        return;
      }
      request = new AbortController();
      setView(current => ({ ...current, loading: current.data === null, refreshing: true, error: null }));
      void getGuestWorld(ownerPublicId, { circleId, targetPublicId, displayName: "" }, request.signal).then(data => {
        if (disposed || id !== sequence) return;
        clock.current = { server: Date.parse(data.serverTime), local: performance.now() };
        setNow(clock.current.server);
        setView({ data, error: null, loading: false, refreshing: false });
      }).catch(error => {
        if (disposed || id !== sequence) return;
        if (error instanceof ApiError && error.status === 401) onLost.current?.();
        setView({ data: null, error: error instanceof Error ? error.message : "Не удалось открыть мир друга.", loading: false, refreshing: false });
      });
    };
    load();
    const poll = setInterval(() => { if (!document.hidden && navigator.onLine) load(); }, 15_000);
    const tick = setInterval(() => { if (!document.hidden && clock.current) setNow(clock.current.server + performance.now() - clock.current.local); }, 1_000);
    document.addEventListener("visibilitychange", load);
    window.addEventListener("online", load);
    window.addEventListener("offline", load);
    window.addEventListener("focus", load);
    return () => {
      disposed = true; ++sequence; request?.abort(); clearInterval(poll); clearInterval(tick);
      document.removeEventListener("visibilitychange", load);
      window.removeEventListener("online", load); window.removeEventListener("offline", load); window.removeEventListener("focus", load);
    };
  }, [ownerPublicId, circleId, targetPublicId, refresh]);

  return { ...view, now, refresh: refreshWorld };
}

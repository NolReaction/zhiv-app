"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { sendPresence } from "./api";
import { createActivitySession } from "./session";
import { setGamePresence } from "./transport-state";
export function useActivity(owner: string | null, reconcile: () => Promise<boolean>, onSessionLost: () => void, onPause: () => void) {
  const session = useMemo(() => ({ owner, session: createActivitySession({ send: sendPresence,
    reconcile: async () => false, sessionLost: () => {}, connected: setGamePresence,
  }) }), [owner]).session;
  useEffect(() => { session.configure({ reconcile, sessionLost: onSessionLost,
    connected: id => { setGamePresence(id); if (!id) onPause(); },
  }); }, [session, reconcile, onSessionLost, onPause]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!owner) return;
    let stop: (() => void) | undefined;
    // The economy/world hooks activate before reconciliation starts (also in StrictMode).
    const kickoff = setTimeout(() => { stop = session.start(navigator.onLine, !document.hidden); }, 0);
    const input = (event: Event) => { if (event.isTrusted) session.input(); };
    const environment = () => session.environment(navigator.onLine, !document.hidden);
    const pageHide = () => session.environment(navigator.onLine, false);
    const clock = setInterval(() => { session.check(); setNow(Date.now()); }, 1000);
    for (const name of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const) window.addEventListener(name, input, { passive: true, capture: true });
    window.addEventListener("online", environment); window.addEventListener("offline", environment);
    window.addEventListener("pagehide", pageHide); window.addEventListener("pageshow", environment);
    window.addEventListener("zhiv:presence-expired", session.expired);
    document.addEventListener("visibilitychange", environment);
    return () => {
      clearTimeout(kickoff); clearInterval(clock); stop?.(); setGamePresence(null);
      for (const name of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const) window.removeEventListener(name, input, { capture: true });
      window.removeEventListener("online", environment); window.removeEventListener("offline", environment);
      window.removeEventListener("pagehide", pageHide); window.removeEventListener("pageshow", environment);
      window.removeEventListener("zhiv:presence-expired", session.expired);
      document.removeEventListener("visibilitychange", environment);
    };
  }, [owner, session]);
  return { ...state, active: state.mode === "active", retrySeconds: Math.max(0, Math.ceil((state.retryAt - now) / 1000)), resume: session.resume, retry: session.retry };
}

"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { getWorld, sendWorldCommand } from "./api";
import { createWorldSession } from "./session";

function receiptStorage() { try { return typeof window === "undefined" ? undefined : window.sessionStorage; } catch { return undefined; } }

export function useWorld(owner: string | null, onSessionLost: () => void, enabled = true) {
  const session = useMemo(() => createWorldSession(owner, { get: getWorld, send: sendWorldCommand }, () => {}, receiptStorage()), [owner]);
  useEffect(() => { session.setSessionLost(onSessionLost); }, [session, onSessionLost]);
  useEffect(() => { session.setAvailable(enabled); }, [session, enabled]);
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!owner) return;
    const deactivate = session.activate();
    const refresh = () => { if (!document.hidden && navigator.onLine) void session.refreshSoft(); };
    const kickoff = setTimeout(() => { if (enabled) void session.refresh(); }, 0);
    const timer = setInterval(() => { if (!document.hidden) setNow(session.now()); }, 1000);
    const polling = setInterval(refresh, 30000);
    document.addEventListener("visibilitychange", refresh); window.addEventListener("online", refresh);
    return () => {
      deactivate(); clearTimeout(kickoff); clearInterval(timer); clearInterval(polling);
      document.removeEventListener("visibilitychange", refresh); window.removeEventListener("online", refresh);
    };
  }, [session, owner, enabled]);
  return { ...view, reconcile: session.reconcile, setAvailable: session.setAvailable, now, act: session.act, retry: session.retry, refresh: session.refreshSoft, refreshNow: session.refresh };
}
export type WorldController = ReturnType<typeof useWorld>;

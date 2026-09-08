"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { getWorld, sendWorldCommand } from "./api";
import { createWorldSession } from "./session";

export function useWorld(owner: string | null, onSessionLost: () => void) {
  const session = useMemo(() => createWorldSession(owner, { get: getWorld, send: sendWorldCommand }, () => {}), [owner]);
  useEffect(() => { session.setSessionLost(onSessionLost); }, [session, onSessionLost]);
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const deactivate = session.activate();
    const refresh = () => { if (!document.hidden) void session.refresh(); };
    const kickoff = setTimeout(refresh, 0);
    const timer = setInterval(() => { if (!document.hidden) setNow(session.now()); }, 1000);
    const polling = setInterval(refresh, 30000);
    document.addEventListener("visibilitychange", refresh); window.addEventListener("online", refresh);
    return () => {
      deactivate(); clearTimeout(kickoff); clearInterval(timer); clearInterval(polling);
      document.removeEventListener("visibilitychange", refresh); window.removeEventListener("online", refresh);
    };
  }, [session]);
  return { ...view, now, act: session.act, retry: session.retry, refresh: session.refresh };
}
export type WorldController = ReturnType<typeof useWorld>;

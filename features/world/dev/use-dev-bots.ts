"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { getDevBots, sendDevBotCommand } from "./dev-bot-api";
import { createDevBotSession } from "./dev-bot-session";

function receiptStorage() {
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}

export function useDevBots(ownerPublicId: string | null, enabled: boolean) {
  const session = useMemo(() => createDevBotSession(ownerPublicId, { get: getDevBots, send: sendDevBotCommand }, receiptStorage(),
    () => !document.hidden && navigator.onLine), [ownerPublicId]);
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getServerSnapshot);
  useEffect(() => { if (enabled && ownerPublicId) return session.activate(); }, [session, enabled, ownerPublicId]);
  useEffect(() => {
    if (!enabled || !ownerPublicId) return;
    const refresh = () => { void session.refresh(); };
    window.addEventListener("focus", refresh); window.addEventListener("online", refresh); window.addEventListener("offline", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); window.removeEventListener("offline", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [session, enabled, ownerPublicId]);
  return { ...view, refresh: session.refresh, command: session.command, retry: session.retry };
}
export type DevBotsController = ReturnType<typeof useDevBots>;

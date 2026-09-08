"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { gameJournalStore } from "@/lib/game-sync-journal";
import { createUuidV4 } from "@/lib/browser-uuid";
import { flushIncidents, reportIncident } from "@/lib/client-incidents";
import type { GameProgress } from "@/lib/game-api";
import { GameSyncClient, type GameSyncSnapshot } from "@/lib/game-sync";

type GameProgressOptions = {
  ownerPublicId: string | null;
  isOnline: boolean;
  onSessionLost: () => void;
};
const initialSnapshot: GameSyncSnapshot = { progress: null, status: "loading", pendingTaps: 0, rejectedTaps: 0, run: null };

export function useGameProgress({ ownerPublicId, isOnline, onSessionLost }: GameProgressOptions) {
  const [state, setState] = useState<GameSyncSnapshot & { ownerPublicId: string | null }>({ ...initialSnapshot, ownerPublicId: null });
  const client = useRef<GameSyncClient | null>(null);
  const writerOwns = useRef<() => boolean>(() => false);
  const owner = useRef(ownerPublicId);
  const sessionLost = useRef(onSessionLost);
  const online = useRef(isOnline);
  useEffect(() => { sessionLost.current = onSessionLost; }, [onSessionLost]);
  useEffect(() => { online.current = isOnline; }, [isOnline]);

  useEffect(() => {
    owner.current = ownerPublicId;
    if (!ownerPublicId) { client.current = null; return; }
    let current: GameSyncClient | null = null;
    let stopped = false;
    const leaseKey = `zhiv:game-writer:v1:${ownerPublicId}`;
    const leaseId = createUuidV4();
    let claiming = false;
    const owns = () => {
      try { return JSON.parse(localStorage.getItem(leaseKey) ?? "null")?.id === leaseId; } catch { return false; }
    };
    writerOwns.current = owns;
    const synchronize = () => {
      if (!current || !owns() || document.hidden) return;
      current.setOnline(navigator.onLine); void current.flush(); void current.refresh();
      void flushIncidents(ownerPublicId);
    };
    const heartbeat = () => {
      if (stopped) return;
      try {
        const lease = JSON.parse(localStorage.getItem(leaseKey) ?? "null");
        if (lease?.id !== leaseId && lease?.until > Date.now()) {
          if (current) { current.dispose(); current = null; client.current = null; }
          setState({ ...initialSnapshot, ownerPublicId, status: "blocked", errorCode: "GAME_ACTIVE_ELSEWHERE" });
          return;
        }
        localStorage.setItem(leaseKey, JSON.stringify({ id: leaseId, until: Date.now() + 8000 }));
        if (!current && !claiming) {
          claiming = true;
          // Verify ownership after competing tabs have observed the same storage event.
          window.setTimeout(() => {
            claiming = false;
            if (stopped || !owns()) return;
            const journal = gameJournalStore(ownerPublicId);
            const guardedJournal = { read: journal.read, write: (value: Parameters<typeof journal.write>[0]) => {
              if (!owns()) throw new Error("Writer changed");
              journal.write(value);
            } };
            const next = new GameSyncClient(ownerPublicId, online.current,
              snapshot => { if (client.current === next) setState({ ...snapshot, ownerPublicId }); },
              () => { if (client.current === next) sessionLost.current(); }, undefined, undefined, undefined, undefined, guardedJournal);
            current = next; client.current = next;
            setState({ ...next.snapshot(), ownerPublicId }); synchronize();
          }, 40);
        } else if (current && !document.hidden) { void current.flush(); void current.refresh(); void flushIncidents(ownerPublicId); }
      } catch {
        setState({ ...initialSnapshot, ownerPublicId, status: "error", errorCode: "STORAGE_FAILED", durable: false });
      }
    };
    const visibility = () => { if (!document.hidden) { heartbeat(); synchronize(); } else if (owns()) void current?.flush(); };
    const offline = () => current?.setOnline(false);
    const flushOnHide = () => { if (owns()) void current?.flush(); };
    const storage = (event: StorageEvent) => { if (event.key === leaseKey && !owns()) heartbeat(); };
    const pageError = () => reportIncident(ownerPublicId, "page", "PAGE_ERROR");
    const rejection = () => reportIncident(ownerPublicId, "page", "UNHANDLED_REJECTION");
    const flushInterval = window.setInterval(heartbeat, 2000);
    heartbeat();
    window.addEventListener("online", synchronize);
    window.addEventListener("offline", offline);
    window.addEventListener("focus", synchronize);
    window.addEventListener("pageshow", synchronize);
    window.addEventListener("pagehide", flushOnHide);
    window.addEventListener("storage", storage);
    window.addEventListener("error", pageError);
    window.addEventListener("unhandledrejection", rejection);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true; current?.dispose();
      if (client.current === current) client.current = null;
      try { if (owns()) localStorage.removeItem(leaseKey); } catch { /* No ownership to release. */ }
      window.clearInterval(flushInterval);
      window.removeEventListener("online", synchronize);
      window.removeEventListener("offline", offline);
      window.removeEventListener("focus", synchronize);
      window.removeEventListener("pageshow", synchronize);
      window.removeEventListener("pagehide", flushOnHide);
      window.removeEventListener("storage", storage);
      window.removeEventListener("error", pageError);
      window.removeEventListener("unhandledrejection", rejection);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [ownerPublicId]);

  useEffect(() => {
    client.current?.setOnline(isOnline);
    if (isOnline) { void client.current?.flush(); void client.current?.refresh(); }
  }, [isOnline]);

  const recordTap = useCallback((steps: number, runId: string) => {
    if (owner.current !== ownerPublicId || document.hidden || !writerOwns.current()) return 0;
    return client.current?.recordTap(steps, runId) ?? 0;
  }, [ownerPublicId]);
  const flush = useCallback(async () => { await client.current?.flush(); }, []);
  const refresh = useCallback(async () => {
    const current = client.current;
    await current?.flush();
    await current?.refresh();
  }, []);
  const adoptProgress = useCallback((progress: GameProgress) => {
    if (progress.ownerPublicId === owner.current) client.current?.adoptProgress(progress);
  }, []);

  // Never expose the previous account's snapshot during the effect transition.
  const visibleState = state.ownerPublicId === ownerPublicId ? state : initialSnapshot;
  return { ...visibleState, recordTap, flush, refresh, adoptProgress };
}

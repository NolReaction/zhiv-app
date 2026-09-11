"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { gameJournalStore } from "@/features/game/game-sync-journal";
import { gameTabInbox } from "@/features/game/game-tab-inbox";
import { createUuidV4 } from "@/lib/browser-uuid";
import { flushIncidents, reportIncident } from "@/lib/client-incidents";
import type { GameProgress } from "@/features/game/game-api";
import { GameSyncClient, type GameSyncSnapshot } from "@/features/game/game-sync";

type GameProgressOptions = { ownerPublicId: string | null; isOnline: boolean; onSessionLost: () => void };
const initialSnapshot: GameSyncSnapshot = { progress: null, status: "loading", pendingTaps: 0, rejectedTaps: 0, run: null };

export function useGameProgress({ ownerPublicId, isOnline, onSessionLost }: GameProgressOptions) {
  const [state, setState] = useState<GameSyncSnapshot & { ownerPublicId: string | null }>({ ...initialSnapshot, ownerPublicId: null });
  const client = useRef<GameSyncClient | null>(null);
  const inputWriter = useRef<(steps: number, runId: string) => number>(() => 0);
  const owner = useRef(ownerPublicId);
  const sessionLost = useRef(onSessionLost);
  const online = useRef(isOnline);
  useEffect(() => { sessionLost.current = onSessionLost; }, [onSessionLost]);
  useEffect(() => { online.current = isOnline; }, [isOnline]);

  useEffect(() => {
    owner.current = ownerPublicId;
    if (!ownerPublicId) { client.current = null; inputWriter.current = () => 0; return; }
    let current: GameSyncClient | null = null;
    let stopped = false, claiming = false, selectedRun: string | undefined;
    let unlock: (() => void) | undefined;
    let claimTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const leaseKey = `zhiv:game-writer:v1:${ownerPublicId}`;
    const journalKey = `zhiv:game-outbox:v1:${ownerPublicId}`;
    const leaseId = createUuidV4();
    const inbox = gameTabInbox(ownerPublicId);
    const owns = () => {
      try {
        const lease = JSON.parse(localStorage.getItem(leaseKey) ?? "null");
        return lease?.id === leaseId && lease.until > Date.now();
      } catch { return false; }
    };
    const storageFailure = () => {
      setState(previous => ({ ...(previous.ownerPublicId === ownerPublicId ? previous : initialSnapshot),
        ownerPublicId, status: "error", errorCode: "STORAGE_FAILED", durable: false }));
    };
    const display = () => {
      if (stopped) return;
      try { setState({ ...inbox.snapshot(online.current, selectedRun, current), ownerPublicId }); }
      catch { storageFailure(); }
    };
    const synchronize = () => {
      if (stopped || document.hidden) return;
      try {
        if (current && owns()) {
          current.setOnline(online.current);
          if (inbox.drain(current) && !drainTimer) {
            drainTimer = setTimeout(() => { drainTimer = undefined; synchronize(); }, 0);
          }
          void current.flush(); void current.refresh(); void flushIncidents(ownerPublicId);
        }
        display();
      } catch { storageFailure(); }
    };
    const release = () => {
      if (claimTimer) clearTimeout(claimTimer);
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = undefined;
      claimTimer = undefined;
      const previous = current;
      // A lost lease cannot overwrite the newer writer's journal.
      previous?.dispose(); current = null;
      if (client.current === previous) client.current = null;
      try { if (owns()) localStorage.removeItem(leaseKey); } catch { /* Keep the outbox intact. */ }
      unlock?.(); unlock = undefined;
      claiming = false;
    };
    const claim = () => {
      if (stopped || document.hidden) { release(); return; }
      try {
        const lease = JSON.parse(localStorage.getItem(leaseKey) ?? "null");
        // Honour older tabs that still use the v1 lease without Web Locks.
        if (lease?.id !== leaseId && lease?.until > Date.now()) { release(); display(); return; }
        localStorage.setItem(leaseKey, JSON.stringify({ id: leaseId, until: Date.now() + 8000 }));
        claimTimer = setTimeout(() => {
          claimTimer = undefined;
          if (stopped || document.hidden || !owns()) { release(); return; }
          const journal = gameJournalStore(ownerPublicId);
          const guardedJournal = { read: journal.read, write: (value: Parameters<typeof journal.write>[0]) => {
            if (!owns()) throw new Error("Writer changed");
            journal.write(value);
          } };
          const next = new GameSyncClient(ownerPublicId, online.current,
            () => { if (client.current === next) display(); },
            () => { if (client.current === next) sessionLost.current(); }, undefined, undefined, undefined, undefined, guardedJournal);
          current = next; client.current = next; claiming = false;
          synchronize();
        }, 40);
      } catch { release(); storageFailure(); }
    };
    const heartbeat = () => {
      if (stopped) return;
      if (document.hidden) { release(); return; }
      if (current && !owns()) release();
      if (current) {
        try { localStorage.setItem(leaseKey, JSON.stringify({ id: leaseId, until: Date.now() + 8000 })); }
        catch { release(); storageFailure(); return; }
        synchronize(); return;
      }
      display();
      if (claiming) return;
      claiming = true;
      if (navigator.locks) {
        // Only dispatch is exclusive. Input remains writable in every visible tab.
        void navigator.locks.request(leaseKey, { ifAvailable: true }, async lock => {
          if (!lock) { claiming = false; return; }
          await new Promise<void>(resolve => { unlock = resolve; claim(); });
        }).catch(() => { release(); storageFailure(); });
      } else claim();
    };
    inputWriter.current = (steps, runId) => {
      if (stopped || document.hidden) return 0;
      selectedRun = runId;
      try {
        const recorded = inbox.record(steps, runId);
        if (!recorded) {
          setState(previous => ({ ...previous, ownerPublicId, errorCode: "QUEUE_FULL" }));
          return 0;
        }
        synchronize(); display();
        return recorded;
      } catch { storageFailure(); return 0; }
    };
    const resume = () => { online.current = navigator.onLine; heartbeat(); };
    const visibility = () => { if (document.hidden) release(); else resume(); };
    const offline = () => { online.current = false; current?.setOnline(false); display(); };
    const storage = (event: StorageEvent) => {
      if (event.key === leaseKey && !owns()) heartbeat();
      else if (event.key?.startsWith(inbox.prefix)) synchronize();
      else if (event.key === journalKey || event.key === null) display();
    };
    const pageError = () => reportIncident(ownerPublicId, "page", "PAGE_ERROR");
    const rejection = () => reportIncident(ownerPublicId, "page", "UNHANDLED_REJECTION");
    const interval = window.setInterval(heartbeat, 2000);
    heartbeat();
    window.addEventListener("online", resume);
    window.addEventListener("offline", offline);
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    window.addEventListener("pagehide", release);
    window.addEventListener("storage", storage);
    window.addEventListener("error", pageError);
    window.addEventListener("unhandledrejection", rejection);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true; inputWriter.current = () => 0; release();
      window.clearInterval(interval);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", offline);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("pagehide", release);
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
    if (owner.current !== ownerPublicId) return 0;
    return inputWriter.current(steps, runId);
  }, [ownerPublicId]);
  const flush = useCallback(async () => { await client.current?.flush(); }, []);
  const refresh = useCallback(async () => { await client.current?.flush(); await client.current?.refresh(); }, []);
  const adoptProgress = useCallback((progress: GameProgress) => {
    if (progress.ownerPublicId === owner.current) client.current?.adoptProgress(progress);
  }, []);
  const visibleState = state.ownerPublicId === ownerPublicId ? state : initialSnapshot;
  return { ...visibleState, recordTap, flush, refresh, adoptProgress };
}

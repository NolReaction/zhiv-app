"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  const owner = useRef(ownerPublicId);
  const sessionLost = useRef(onSessionLost);
  const online = useRef(isOnline);
  useEffect(() => { sessionLost.current = onSessionLost; }, [onSessionLost]);
  useEffect(() => { online.current = isOnline; }, [isOnline]);

  useEffect(() => {
    owner.current = ownerPublicId;
    if (!ownerPublicId) { client.current = null; return; }
    const current = new GameSyncClient(ownerPublicId, online.current,
      snapshot => { if (client.current === current) setState({ ...snapshot, ownerPublicId }); },
      () => { if (client.current === current) sessionLost.current(); });
    client.current = current;
    queueMicrotask(() => { if (client.current === current) setState({ ...current.snapshot(), ownerPublicId }); });
    void current.refresh();

    const synchronize = () => {
      if (document.hidden) return;
      current.setOnline(navigator.onLine);
      void current.flush();
      void current.refresh();
    };
    const visibility = () => {
      if (document.hidden) void current.flush();
      else synchronize();
    };
    const offline = () => current.setOnline(false);
    const flush = () => { if (!document.hidden) void current.flush(); };
    const flushOnHide = () => { void current.flush(); };
    const flushInterval = window.setInterval(flush, 750);
    window.addEventListener("online", synchronize);
    window.addEventListener("offline", offline);
    window.addEventListener("focus", synchronize);
    window.addEventListener("pageshow", synchronize);
    window.addEventListener("pagehide", flushOnHide);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      current.dispose();
      if (client.current === current) client.current = null;
      window.clearInterval(flushInterval);
      window.removeEventListener("online", synchronize);
      window.removeEventListener("offline", offline);
      window.removeEventListener("focus", synchronize);
      window.removeEventListener("pageshow", synchronize);
      window.removeEventListener("pagehide", flushOnHide);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [ownerPublicId]);

  useEffect(() => {
    client.current?.setOnline(isOnline);
    if (isOnline) { void client.current?.flush(); void client.current?.refresh(); }
  }, [isOnline]);

  const recordTap = useCallback((steps: number, runId: string) => {
    if (owner.current !== ownerPublicId || document.hidden) return 0;
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

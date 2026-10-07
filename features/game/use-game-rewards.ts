"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { claimGameReward, getGameRewards, type GameRewardResult } from "./game-rewards-api";
import { createGameRewardsSession } from "./game-rewards-session";

const sessions = new Map<string | null, ReturnType<typeof createGameRewardsSession>>();
function sessionFor(owner: string | null) {
  let session = sessions.get(owner);
  if (!session) {
    let storage: Storage | undefined;
    try { storage = typeof window === "undefined" ? undefined : window.sessionStorage; } catch { /* In-memory recovery still works. */ }
    session = createGameRewardsSession(owner, { get: getGameRewards, send: claimGameReward }, storage);
    sessions.set(owner, session);
  }
  return session;
}
export function useGameRewards(owner: string | null, isOnline: boolean, onSessionLost?: () => void, onConfirmed?: (result: GameRewardResult) => void) {
  const session = useMemo(() => sessionFor(owner), [owner]);
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [now, setNow] = useState(() => session.now());
  useEffect(() => onSessionLost ? session.onSessionLost(onSessionLost) : undefined, [session, onSessionLost]);
  useEffect(() => {
    if (!owner || !isOnline) return;
    const deactivate = session.activate();
    const refresh = () => { if (!document.hidden) void session.refresh(); };
    const kickoff = setTimeout(refresh, 0);
    const tick = setInterval(() => { if (!document.hidden) setNow(session.now()); }, 1000);
    const poll = setInterval(refresh, 45_000);
    window.addEventListener("focus", refresh); window.addEventListener("online", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { deactivate(); clearTimeout(kickoff); clearInterval(tick); clearInterval(poll);
      window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [owner, session, isOnline]);
  const confirm = async (action: () => Promise<GameRewardResult | undefined>) => { const result = await action(); if (result) onConfirmed?.(result); };
  return { ...view, now: view.data ? session.now() : now,
    refresh: session.refresh, claimDaily: () => confirm(session.claimDaily),
    claimAchievement: (...args: Parameters<typeof session.claimAchievement>) => confirm(() => session.claimAchievement(...args)),
    retry: () => confirm(session.retry) };
}
export type GameRewardsController = ReturnType<typeof useGameRewards>;

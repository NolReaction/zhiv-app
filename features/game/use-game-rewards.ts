"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { claimGameReward, getGameRewards, type GameRewardResult } from "./game-rewards-api";
import type { GameAchievementId } from "./game-api";
import { createGameRewardsSession } from "./game-rewards-session";
import { claimDailyWithAudio } from "./game-rewards-audio";
import { createGameRewardsRefresh } from "./game-rewards-refresh";

type RewardsService = { session: ReturnType<typeof createGameRewardsSession>; connect: () => () => void };
const sessions = new Map<string | null, RewardsService>();
function sessionFor(owner: string | null) {
  let service = sessions.get(owner);
  if (!service) {
    let storage: Storage | undefined;
    try { storage = typeof window === "undefined" ? undefined : window.sessionStorage; } catch { /* In-memory recovery still works. */ }
    const session = createGameRewardsSession(owner, { get: getGameRewards, send: claimGameReward }, storage);
    service = { session, connect: createGameRewardsRefresh(session) };
    sessions.set(owner, service);
  }
  return service;
}
export function useGameRewards(owner: string | null, isOnline: boolean, onSessionLost?: () => void, onConfirmed?: (result: GameRewardResult) => void) {
  const { session, connect } = useMemo(() => sessionFor(owner), [owner]);
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [now, setNow] = useState(() => session.now());
  const confirmed = useRef({ owner, callback: onConfirmed });
  useEffect(() => { confirmed.current = { owner, callback: onConfirmed }; }, [owner, onConfirmed]);
  useEffect(() => onSessionLost ? session.onSessionLost(onSessionLost) : undefined, [session, onSessionLost]);
  useEffect(() => {
    if (!owner || !isOnline) return;
    const disconnect = connect();
    const tick = setInterval(() => { if (!document.hidden) setNow(session.now()); }, 1000);
    return () => { disconnect(); clearInterval(tick); };
  }, [owner, session, connect, isOnline]);
  const confirm = useCallback(async (action: () => Promise<GameRewardResult | undefined>) => {
    const result = await action();
    if (!result || result.rewards.ownerPublicId !== confirmed.current.owner) return;
    confirmed.current.callback?.(result);
    return result;
  }, []);
  const claimDaily = useCallback(() => confirm(() => claimDailyWithAudio(owner, session, event => getAudioRuntime().play(event))), [confirm, owner, session]);
  const claimOnboarding = useCallback(() => confirm(session.claimOnboarding), [confirm, session]);
  const claimAchievement = useCallback((achievementId: GameAchievementId, level: number) => confirm(() => session.claimAchievement(achievementId, level)), [confirm, session]);
  const retry = useCallback(() => confirm(session.retry), [confirm, session]);
  return { ...view, now: view.data ? session.now() : now,
    refresh: session.refresh, claimDaily, claimOnboarding, claimAchievement, retry };
}
export type GameRewardsController = ReturnType<typeof useGameRewards>;

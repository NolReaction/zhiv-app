"use client";

import { useMemo, useSyncExternalStore, type RefObject } from "react";

export const ONBOARDING_REWARD_DELAY_MS = 60_000;
type RewardOnboarding = {
  loaded: boolean;
  progress: { status: "started" | "skipped" | "completed"; finishedAt?: number } | null;
};
type RewardPromptGate = { allowed: boolean; nextCheckAt: number | null };

/** No reward commands: this decides only when an automatic invitation may appear. */
export function getWorldRewardPromptGate(onboarding: RewardOnboarding, nowMs: number, busyUI = false): RewardPromptGate {
  if (!onboarding.loaded || !onboarding.progress || onboarding.progress.status === "started") {
    return { allowed: false, nextCheckAt: null };
  }
  const finishedAt = onboarding.progress.finishedAt;
  // Existing terminal preferences predate the timer and keep their ordinary gift behavior.
  if (finishedAt === undefined || !Number.isFinite(finishedAt) || finishedAt < 0) {
    return { allowed: !busyUI, nextCheckAt: null };
  }
  if (!Number.isFinite(nowMs)) return { allowed: false, nextCheckAt: null };
  const delay = Math.min(ONBOARDING_REWARD_DELAY_MS, Math.max(0, finishedAt + ONBOARDING_REWARD_DELAY_MS - nowMs));
  return delay > 0 ? { allowed: false, nextCheckAt: nowMs + delay } : { allowed: !busyUI, nextCheckAt: null };
}

type GateRuntime = {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => number;
  cancel: (timer: number) => void;
  onWake: (callback: () => void) => () => void;
};
const browserRuntime: GateRuntime = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
  cancel: timer => window.clearTimeout(timer),
  onWake(callback) {
    window.addEventListener("pageshow", callback);
    document.addEventListener("visibilitychange", callback);
    return () => { window.removeEventListener("pageshow", callback); document.removeEventListener("visibilitychange", callback); };
  },
};

/** A single deadline per owner/finish. A clock moved backwards never extends it indefinitely. */
export function createWorldRewardPromptGateStore(owner: string, onboarding: RewardOnboarding, runtime: GateRuntime = browserRuntime) {
  let allowed = false, deadline: number | null | undefined;
  let timer: number | null = null, stopWake: (() => void) | undefined, generation = 0;
  const listeners = new Set<() => void>();
  const notifyAllowed = () => {
    if (allowed) return;
    allowed = true;
    for (const listener of listeners) listener();
  };
  const cancelTimer = () => { if (timer !== null) runtime.cancel(timer); timer = null; };
  const start = () => {
    const now = runtime.now();
    const gate = getWorldRewardPromptGate(onboarding, now);
    if (allowed || gate.allowed) { notifyAllowed(); return; }
    if (deadline === undefined) deadline = gate.nextCheckAt;
    if (deadline === null) return;
    if (deadline <= now) { notifyAllowed(); return; }
    const token = ++generation;
    timer = runtime.schedule(() => {
      if (token !== generation || !listeners.size) return;
      timer = null;
      // The scheduled elapsed minute is sufficient even after a wall-clock change.
      notifyAllowed();
    }, Math.min(ONBOARDING_REWARD_DELAY_MS, deadline - now));
    stopWake = runtime.onWake(() => {
      if (token !== generation || !listeners.size || runtime.now() < deadline!) return;
      cancelTimer();
      notifyAllowed();
    });
  };
  return {
    owner,
    getSnapshot: () => allowed,
    getServerSnapshot: () => false,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        generation++;
        cancelTimer(); stopWake?.(); stopWake = undefined;
      };
    },
  };
}

/** Radix hides the covered map from accessibility when any foreground modal owns interaction. */
export function createWorldRewardSurfaceStore(surface?: RefObject<HTMLElement | null>) {
  let covered = Boolean(surface);
  return {
    getSnapshot: () => covered,
    getServerSnapshot: () => Boolean(surface),
    subscribe(listener: () => void) {
      if (!surface) return () => {};
      const inspect = () => {
        const element = surface.current;
        const next = !element || !element.isConnected || Boolean(element.closest('[aria-hidden="true"], [inert], [hidden]'));
        if (next === covered) return;
        covered = next;
        listener();
      };
      const observer = new MutationObserver(inspect);
      observer.observe(document.body, { subtree: true, childList: true, attributes: true,
        attributeFilter: ["aria-hidden", "inert", "hidden"] });
      inspect();
      return () => observer.disconnect();
    },
  };
}

/** Busy UI holds a ready invitation without resetting its persisted completion deadline. */
export function useWorldRewardPromptGate(owner: string, onboarding: RewardOnboarding, busyUI: boolean, surface?: RefObject<HTMLElement | null>) {
  const { loaded } = onboarding;
  const status = onboarding.progress?.status, finishedAt = onboarding.progress?.finishedAt;
  const store = useMemo(() => createWorldRewardPromptGateStore(owner,
    { loaded, progress: status ? { status, finishedAt } : null }), [owner, loaded, status, finishedAt]);
  const allowed = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const surfaceStore = useMemo(() => createWorldRewardSurfaceStore(surface), [surface]);
  const covered = useSyncExternalStore(surfaceStore.subscribe, surfaceStore.getSnapshot, surfaceStore.getServerSnapshot);
  return allowed && !busyUI && !covered;
}

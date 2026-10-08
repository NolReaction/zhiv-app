"use client";

import { useEffect, useRef, useState } from "react";
import { HOME_BACKGROUND_STYLE } from "@/features/world/legacy/map-layout";
import { WORLD_PRESENTATION } from "@/features/world/scene/presentation";
import type { WorldState } from "@/features/world/domain/model";
import type { EconomySceneBuildings, EconomySceneJourney } from "@/features/world/state/economy/economy-scene-state";
import type { EconomySceneProduction } from "@/features/world/state/economy/economy-production-state";
import type { EconomySceneConstruction } from "@/features/world/state/economy/economy-construction-state";
import type { WorldActivity } from "@/features/world/ui/hud/world-activity";
import { WorldActivityBadge, WorldActivityDescription } from "@/features/world/ui/hud/world-activity-badge";
import type { GameItemId } from "@/features/game/game-rewards";
import { reportIncident } from "@/lib/client-incidents";
import { HabitatAssetError } from "@/features/mochlik/assets";
import { bindSceneLoaderEnvironment, createSceneLoader } from "@/features/startup/scene-loader";
import type { SceneLoadState } from "@/features/startup/scene-load-state";
import { habitatLighting } from "@/features/mochlik/lighting";
import type { HabitatScene, SceneOptions } from "@/features/mochlik/scene";
import styles from "./mochlik-terrarium.module.css";
import { useGardenCollection } from "@/features/economy/integration/garden-collection-context";

type Props = { wakeSignal: number; suspended?: boolean; nowMs: number; timeZone: string; userId?: string; bestStreakDays?: number; items?: readonly GameItemId[]; worldState?: WorldState; worldGifts?: readonly string[]; economyJourney?: EconomySceneJourney | null; cancelledExplorations?: readonly string[]; economyBuildings?: EconomySceneBuildings | null; economyProduction?: EconomySceneProduction | null; economyConstruction?: EconomySceneConstruction | null; activity?: WorldActivity | null; onLoadState?: (state: SceneLoadState) => void; retrySignal?: number };

// Decorative content of the same native check-in button; it never records taps.
export function MochlikTerrarium({ wakeSignal, suspended = false, nowMs, timeZone, userId, bestStreakDays = 0, items, worldState, worldGifts, economyJourney, cancelledExplorations, economyBuildings, economyProduction, economyConstruction, activity, onLoadState, retrySignal = 0 }: Props) {
  const garden = useGardenCollection();
  const canvas = useRef<HTMLCanvasElement>(null);
  const time = useRef(nowMs);
  useEffect(() => { time.current = nowMs; scene.current?.setTime(nowMs); }, [nowMs]);
  const previousWake = useRef(wakeSignal);
  const pendingWake = useRef(0);
  const scene = useRef<HabitatScene | null>(null);
  const { lampOn, dusk } = habitatLighting(nowMs, timeZone);
  const presenceKey = userId ? `zhiv:mochlik:presence:${userId}` : undefined;
  const options = useRef<SceneOptions>({ lampOn, dusk, paused: false, backgrounded: suspended, reducedMotion: false, presenceKey, bestStreakDays, items, worldState, worldGifts, economyJourney, cancelledExplorations, economyBuildings, economyProduction, economyConstruction, economyGarden: garden?.crop, gardenHarvestRequest: garden?.request, onGardenHarvestEvent: garden?.sceneEvent });
  const [loadState, setLoadState] = useState<SceneLoadState>("loading");
  const ready = loadState === "ready", failed = loadState === "error";
  const loader = useRef<ReturnType<typeof createSceneLoader<HabitatScene>> | null>(null);
  const loadCallback = useRef(onLoadState);
  useEffect(() => { loadCallback.current = onLoadState; }, [onLoadState]);
  useEffect(() => { loadCallback.current?.(loadState); }, [loadState]);
  const previousRetry = useRef(retrySignal);
  const inView = useRef(true);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const refresh = () => {
      options.current = { lampOn, dusk, paused: false, backgrounded: suspended || document.hidden || !inView.current, reducedMotion: media.matches, presenceKey, bestStreakDays, items, worldState, worldGifts, economyJourney, cancelledExplorations, economyBuildings, economyProduction, economyConstruction, economyGarden: garden?.crop, gardenHarvestRequest: garden?.request, onGardenHarvestEvent: garden?.sceneEvent };
      scene.current?.configure(options.current);
    };
    const observer = new IntersectionObserver(entries => { inView.current = entries.some(entry => entry.isIntersecting); refresh(); });
    if (canvas.current) observer.observe(canvas.current);
    const pageHide = () => scene.current?.configure({ ...options.current, backgrounded: true });
    refresh(); document.addEventListener("visibilitychange", refresh); media.addEventListener("change", refresh);
    window.addEventListener("pagehide", pageHide); window.addEventListener("pageshow", refresh);
    return () => {
      observer.disconnect(); document.removeEventListener("visibilitychange", refresh); media.removeEventListener("change", refresh);
      window.removeEventListener("pagehide", pageHide); window.removeEventListener("pageshow", refresh);
    };
  }, [lampOn, dusk, suspended, presenceKey, bestStreakDays, items, worldState, worldGifts, economyJourney, cancelledExplorations, economyBuildings, economyProduction, economyConstruction, garden]);

  // Reconcile visibility/absence first, so a tap on the returning render is not reset.
  useEffect(() => {
    if (wakeSignal === previousWake.current) return;
    const taps = Math.max(0, wakeSignal - previousWake.current);
    previousWake.current = wakeSignal;
    if (failed) {
      loader.current?.retry();
      return;
    }
    if (scene.current) { for (let i = 0; i < taps; i++) scene.current.notice(); }
    else pendingWake.current += taps;
  }, [wakeSignal, failed]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const release = (value: HabitatScene) => {
      value.dispose();
      if (scene.current === value) scene.current = null;
    };
    const loading = createSceneLoader<HabitatScene>({
      async load(signal) {
        const { mountHabitat } = await import("@/features/mochlik/scene");
        signal.throwIfAborted();
        return new Promise<HabitatScene>((resolve, reject) => {
          let value: HabitatScene | undefined;
          const cleanup = () => signal.removeEventListener("abort", abort);
          const failure = (error?: unknown) => { cleanup(); if (value) release(value); reject(error); };
          const abort = () => failure(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          try {
            value = mountHabitat(element, { ...options.current, serverNow: time.current }, {
              activity() {},
              ready: () => queueMicrotask(() => {
                cleanup();
                if (signal.aborted) { if (value) release(value); reject(signal.reason); }
                else resolve(value!);
              }),
              failure,
            });
            scene.current = value;
            const taps = pendingWake.current; pendingWake.current = 0;
            for (let i = 0; i < taps; i++) value.notice();
          } catch (error) { failure(error); }
        });
      },
      release,
      onReady() {},
      onState(state, error) {
        setLoadState(state);
        if (state === "error" && userId) reportIncident(userId, "world", error instanceof HabitatAssetError && error.timedOut ? "WORLD_CHARACTER_TIMEOUT" : "WORLD_CHARACTER_FAILED");
      },
    });
    loader.current = loading;
    const unbind = bindSceneLoaderEnvironment(loading);
    loading.retry();
    return () => { unbind(); loading.dispose(); if (loader.current === loading) loader.current = null; };
  }, [userId]);

  useEffect(() => {
    if (retrySignal === previousRetry.current) return;
    previousRetry.current = retrySignal;
    loader.current?.retry();
  }, [retrySignal]);

  return <><div className={styles.scene} data-pet-interaction data-ready={ready} data-light={dusk ? "dusk" : "day"} aria-hidden="true">
    <div className={styles.fallback} style={WORLD_PRESENTATION.rebuilding ? undefined : HOME_BACKGROUND_STYLE} />
    <canvas ref={canvas} className={styles.canvas} />
    <div className={styles.glass} />
    {!ready && <span className={styles.loadState}>{failed ? "Восстанавливаем лес… Нажми, чтобы повторить сейчас" : "Загружаем Мохлика…"}</span>}
    {activity && <span className={styles.activity}><WorldActivityBadge activity={activity} /></span>}
  </div>{activity && <WorldActivityDescription id="mochlik-activity-status" activity={activity} />}</>;
}

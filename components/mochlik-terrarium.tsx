"use client";

import { useEffect, useRef, useState } from "react";
import type { WorldState } from "@/features/world/model";
import { JourneyProgress } from "@/features/world/journey-progress";
import type { GameItemId } from "@/lib/game-rewards";
import { habitatLighting } from "@/lib/mochlik/lighting";
import type { HabitatScene, SceneOptions } from "@/lib/mochlik/scene";
import styles from "./mochlik-terrarium.module.css";

type Props = { wakeSignal: number; suspended?: boolean; nowMs: number; timeZone: string; userId?: string; bestStreakDays?: number; items?: readonly GameItemId[]; worldState?: WorldState; worldGifts?: readonly string[] };

// Decorative content of the same native check-in button; it never records taps.
export function MochlikTerrarium({ wakeSignal, suspended = false, nowMs, timeZone, userId, bestStreakDays = 0, items, worldState, worldGifts }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const previousWake = useRef(wakeSignal);
  const pendingWake = useRef(0);
  const scene = useRef<HabitatScene | null>(null);
  const { lampOn, dusk } = habitatLighting(nowMs, timeZone);
  const presenceKey = userId ? `zhiv:mochlik:presence:${userId}` : undefined;
  const options = useRef<SceneOptions>({ lampOn, dusk, paused: false, backgrounded: suspended, reducedMotion: false, presenceKey, bestStreakDays, items, worldState, worldGifts });
  const [ready, setReady] = useState(false);
  const inView = useRef(true);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const refresh = () => {
      options.current = { lampOn, dusk, paused: false, backgrounded: suspended || document.hidden || !inView.current, reducedMotion: media.matches, presenceKey, bestStreakDays, items, worldState, worldGifts };
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
  }, [lampOn, dusk, suspended, presenceKey, bestStreakDays, items, worldState, worldGifts]);

  // Reconcile visibility/absence first, so a tap on the returning render is not reset.
  useEffect(() => {
    if (wakeSignal === previousWake.current) return;
    const taps = Math.max(0, wakeSignal - previousWake.current);
    previousWake.current = wakeSignal;
    if (scene.current) { for (let i = 0; i < taps; i++) scene.current.notice(); }
    else pendingWake.current += taps;
  }, [wakeSignal]);

  useEffect(() => {
    let active = true;
    const element = canvas.current;
    if (!element) return;
    void import("@/lib/mochlik/scene").then(({ mountHabitat }) => {
      if (!active) return;
      scene.current = mountHabitat(element, options.current, {
        activity() {},
        ready: () => { if (active) setReady(true); },
        failure: () => { if (active) setReady(false); },
      });
      const taps = pendingWake.current; pendingWake.current = 0;
      for (let i = 0; i < taps; i++) scene.current.notice();
    }).catch(() => { if (active) setReady(false); });
    return () => { active = false; scene.current?.dispose(); scene.current = null; };
  }, []);

  return <div className={styles.scene} data-pet-interaction data-ready={ready} data-light={dusk ? "dusk" : "day"} aria-hidden="true">
    <div className={styles.fallback} />
    <canvas ref={canvas} className={styles.canvas} />
    <div className={styles.glass} />
    {worldState?.journeys[0] && <span className={styles.journey}><JourneyProgress journey={worldState.journeys[0]} equipment={worldState.equipment} now={nowMs} paused={suspended} /></span>}
  </div>;
}

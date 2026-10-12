"use client";

import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { createMenuAudioController } from "@/features/audio/ui/menu-audio";
import { habitatLighting } from "@/features/mochlik/lighting";
import { TILED_WORLD } from "@/features/world/scene/presentation";
import { WORLD_DEV_ENABLED, worldDevStore } from "@/features/world/dev/world-dev-store";
import { getStartupAudioEntry } from "@/features/startup/startup-audio";

type Options = { active: boolean; handoff: boolean; ownerPublicId: string | null; nowMs: number; timeZone: string };
const serverTimeOfDay = () => "auto" as const;
const currentTimeOfDay = () => WORLD_DEV_ENABLED ? worldDevStore.getSnapshot().timeOfDay : "auto";

/** The app owns music only while no visible forest surface owns the mix. */
export function useMenuAudio({ active, handoff, ownerPublicId, nowMs, timeZone }: Options) {
  const ownerId = `menu-audio-${useId()}`;
  const controller = useRef<ReturnType<typeof createMenuAudioController> | null>(null);
  const timeOfDay = useSyncExternalStore(worldDevStore.subscribe, currentTimeOfDay, serverTimeOfDay);
  const night = timeOfDay === "auto" ? habitatLighting(nowMs, timeZone).dusk : timeOfDay === "night";
  const sceneId = ownerPublicId ? `zhiv:mochlik:presence:${ownerPublicId}:${TILED_WORLD.id}` : null;
  useEffect(() => {
    if (!ownerPublicId) return;
    const controller = new AbortController();
    const runtime = getAudioRuntime();
    let controlsReady = false;
    const prepareForest = () => {
      if (!controlsReady || document.hidden) return;
      const settings = runtime.getSettings();
      if (!settings.enabled || settings.master <= 0) return;
      const cues = [settings.buses.weather > 0 ? "weather.wind" : null,
        settings.buses.ambience > 0 ? (night ? "forest.night" : "forest.day") : null,
        settings.buses.ambience > 0 ? "river" : null]
        .filter((cue): cue is string => cue !== null);
      if (cues.length) void runtime.prepare(cues, { signal: controller.signal }).catch(() => {});
    };
    const prepare = () => {
      if (!document.hidden) void runtime.prepare([night ? "music.night" : "music.day"], { signal: controller.signal }).catch(() => {});
      prepareForest();
    };
    // Hydration selects the actual profile timezone/DEV track while the splash
    // still covers the screen. Warming a song never starts its media element.
    prepare();
    const unsubscribe = getStartupAudioEntry(runtime, { visible: () => !document.hidden }).subscribe(() => {
      controlsReady = true;
      // Warm the common river too, before the camera reaches the water. Other
      // localized buildings/weather variants keep on-demand loading.
      prepareForest();
    });
    document.addEventListener("visibilitychange", prepare);
    return () => { controller.abort(); unsubscribe(); document.removeEventListener("visibilitychange", prepare); };
  }, [ownerPublicId, night]);
  useEffect(() => {
    const current = createMenuAudioController(getAudioRuntime(), ownerId);
    controller.current = current;
    return () => { current.dispose(); if (controller.current === current) controller.current = null; };
  }, [ownerId]);
  useEffect(() => {
    controller.current?.update({ active, handoff, sceneId, night });
  }, [active, handoff, sceneId, night, ownerId]);
}

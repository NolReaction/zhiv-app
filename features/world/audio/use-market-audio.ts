"use client";

import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { createMarketAudioController } from "@/features/audio/ui/market-audio";
import { habitatLighting } from "@/features/mochlik/lighting";
import { TILED_WORLD } from "@/features/world/scene/presentation";
import { WORLD_DEV_ENABLED, worldDevStore } from "@/features/world/dev/world-dev-store";

const serverTimeOfDay = () => "auto" as const;
const currentTimeOfDay = () => WORLD_DEV_ENABLED ? worldDevStore.getSnapshot().timeOfDay : "auto";
type Options = { active: boolean; suspended?: boolean; ownerPublicId: string; now: number; timeZone: string; readOnly?: boolean };

/** The counter temporarily owns this map's existing mix, without another player. */
export function useMarketAudio({ active, suspended = false, ownerPublicId, now, timeZone, readOnly = false }: Options) {
  const ownerId = `market-audio-${useId()}`;
  const controller = useRef<ReturnType<typeof createMarketAudioController> | null>(null);
  const timeOfDay = useSyncExternalStore(worldDevStore.subscribe, currentTimeOfDay, serverTimeOfDay);
  const night = !readOnly && timeOfDay !== "auto" ? timeOfDay === "night" : habitatLighting(now, timeZone).dusk;
  const sceneId = `zhiv:mochlik:presence:${ownerPublicId}:${TILED_WORLD.id}`;
  useEffect(() => {
    const preparation = new AbortController();
    // Warm the compact signature before opening. Muted preparation does not
    // unlock playback; late decoding still cannot outlive the counter lease.
    if (!document.hidden) void getAudioRuntime().prepare(["ui.market-open"], { signal: preparation.signal }).catch(() => {});
    return () => preparation.abort();
  }, [ownerPublicId]);
  useEffect(() => {
    const current = createMarketAudioController(getAudioRuntime(), ownerId);
    controller.current = current;
    return () => { current.dispose(); if (controller.current === current) controller.current = null; };
  }, [ownerId]);
  useEffect(() => { controller.current?.update({ active, suspended, sceneId, night }); }, [active, suspended, sceneId, night, ownerId]);
}

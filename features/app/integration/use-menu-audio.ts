"use client";

import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { createMenuAudioController } from "@/features/audio/ui/menu-audio";
import { habitatLighting } from "@/features/mochlik/lighting";
import { TILED_WORLD } from "@/features/world/scene/presentation";
import { WORLD_DEV_ENABLED, worldDevStore } from "@/features/world/dev/world-dev-store";

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
    const current = createMenuAudioController(getAudioRuntime(), ownerId);
    controller.current = current;
    return () => { current.dispose(); if (controller.current === current) controller.current = null; };
  }, [ownerId]);
  useEffect(() => {
    controller.current?.update({ active, handoff, sceneId, night });
  }, [active, handoff, sceneId, night, ownerId]);
}

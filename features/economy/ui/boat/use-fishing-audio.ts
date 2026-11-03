"use client";

import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { createFishingAudioController, FISHING_AUDIO_CUES, type FishingAudioState } from "@/features/audio/ui/fishing-audio";
import { TILED_WORLD } from "@/features/world/scene/presentation";

const visibleSnapshot = () => !document.hidden && document.hasFocus();
const serverVisibleSnapshot = () => false;
const subscribeVisibility = (notify: () => void) => {
  document.addEventListener("visibilitychange", notify); window.addEventListener("blur", notify); window.addEventListener("focus", notify);
  return () => { document.removeEventListener("visibilitychange", notify); window.removeEventListener("blur", notify); window.removeEventListener("focus", notify); };
};

type Options = Omit<FishingAudioState, "sceneId"> & { ownerPublicId: string };

/** A temporary owner of the shared audio graph; never allocates another player/context. */
export function useFishingAudio({ ownerPublicId, voyageId, stage, castKey, held, progress, inZone, caughtCount, suspended = false, ambience }: Options) {
  const ownerId = `fishing-audio-${useId()}`;
  const controller = useRef<ReturnType<typeof createFishingAudioController> | null>(null);
  const visible = useSyncExternalStore(subscribeVisibility, visibleSnapshot, serverVisibleSnapshot);
  const sceneId = `zhiv:mochlik:presence:${ownerPublicId}:${TILED_WORLD.id}`;
  useEffect(() => {
    const runtime = getAudioRuntime(), current = createFishingAudioController(runtime, ownerId);
    const preparation = new AbortController();
    controller.current = current;
    void runtime.prepare(FISHING_AUDIO_CUES, { signal: preparation.signal }).catch(() => {});
    return () => { preparation.abort(); current.dispose(); if (controller.current === current) controller.current = null; };
  }, [ownerId]);
  useEffect(() => { controller.current?.update({ sceneId, voyageId, stage, castKey, held, progress, inZone, caughtCount, ambience,
    suspended: suspended || !visible || document.hidden }); },
  [ownerId, sceneId, voyageId, stage, castKey, held, progress, inZone, caughtCount, suspended, visible, ambience]);
}

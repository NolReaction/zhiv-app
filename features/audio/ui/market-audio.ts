import type { AudioFrame, AudioRuntime } from "@/features/audio/domain/types";
import { menuAudioFrame } from "./menu-audio";

export type MarketAudioState = { active: boolean; suspended?: boolean; sceneId: string | null; night: boolean };

/** Retain the map's music decks and position while the counter comes forward. */
export function marketAudioFrame(ownerId: string, sceneId: string, night: boolean): AudioFrame {
  const frame = menuAudioFrame(ownerId, sceneId, night);
  return { ...frame, musicDuck: .3, sources: frame.sources?.map(source => ({ ...source, reason: "market" })) };
}

/** Market openings only soften the existing music; no entrance sound. */
export function createMarketAudioController(runtime: AudioRuntime, ownerId: string) {
  let previous: MarketAudioState | null = null;
  let retained = false, disposed = false;
  return {
    update(next: MarketAudioState) {
      if (disposed) return;
      if (!next.active || !next.sceneId) {
        if (retained) runtime.clearFrame(ownerId);
        retained = false; previous = null;
        return;
      }
      if (next.suspended) {
        if (retained) runtime.clearFrame(ownerId);
        // Suspension releases playback, but the already open counter remains
        // the same entrance when the app becomes interactive again.
        retained = false; previous = { ...next };
        return;
      }
      if (retained && previous?.sceneId === next.sceneId && previous.night === next.night) return;
      runtime.updateFrame(marketAudioFrame(ownerId, next.sceneId, next.night));
      retained = true; previous = { ...next };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (retained) runtime.clearFrame(ownerId);
      retained = false; previous = null;
    },
  };
}

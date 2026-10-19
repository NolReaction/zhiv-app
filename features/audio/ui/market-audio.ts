import type { AudioFrame, AudioRuntime } from "@/features/audio/domain/types";
import { menuAudioFrame } from "./menu-audio";

export type MarketAudioState = { active: boolean; suspended?: boolean; sceneId: string | null; night: boolean };
let nextCounter = 0;

/** Retain the map's music decks and position while the counter comes forward. */
export function marketAudioFrame(ownerId: string, sceneId: string, night: boolean): AudioFrame {
  const frame = menuAudioFrame(ownerId, sceneId, night);
  return { ...frame, musicDuck: .3, sources: frame.sources?.map(source => ({ ...source, reason: "market" })) };
}

/** One opening gesture, never a reward or a polling/visibility notification. */
export function createMarketAudioController(runtime: AudioRuntime, ownerId: string) {
  const counterId = ++nextCounter;
  let previous: MarketAudioState | null = null;
  let retained = false, disposed = false, sequence = 0;
  let openingToken: object | null = null;
  return {
    update(next: MarketAudioState) {
      if (disposed) return;
      if (!next.active || !next.sceneId) {
        if (retained) runtime.clearFrame(ownerId);
        retained = false; previous = null; openingToken = null;
        return;
      }
      if (next.suspended) {
        if (retained) runtime.clearFrame(ownerId);
        // Suspension releases playback, but the already open counter remains
        // the same entrance when the app becomes interactive again.
        retained = false; previous = { ...next }; openingToken = null;
        return;
      }
      if (retained && previous?.sceneId === next.sceneId && previous.night === next.night) return;
      const opening = previous?.sceneId !== next.sceneId;
      runtime.updateFrame(marketAudioFrame(ownerId, next.sceneId, next.night));
      retained = true; previous = { ...next };
      if (opening) {
        const token = openingToken = {}, occurredAt = Date.now(), id = `${ownerId}:${counterId}:open:${++sequence}`;
        // React's development effect probe can acquire and immediately release
        // a view. Consume only the surviving acquisition, not that probe.
        queueMicrotask(() => {
          if (!disposed && retained && openingToken === token) runtime.play({ id, cueId: "ui.market-open",
            ownerId, occurredAt, maxAgeMs: 400 });
        });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (retained) runtime.clearFrame(ownerId);
      retained = false; previous = null; openingToken = null;
    },
  };
}

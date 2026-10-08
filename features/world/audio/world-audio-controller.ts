import type { AudioFrame, AudioRuntime } from "@/features/audio/domain/types";
import type { FixedWorldScene } from "@/features/world/tiled/types";
import type { ForestSessionState } from "@/features/world/state/forest-session";
import { buildWorldAudioFrame, type WorldAudioEnvironment } from "./world-audio-frame";
import { createWorldAudioMarkerTracker, worldAudioMarkers } from "./world-audio-markers";

let nextOwner = 0;
const trackers = new WeakMap<ForestSessionState, ReturnType<typeof createWorldAudioMarkerTracker>>();
export type WorldAudioControl = {
  visible: boolean; observationOwner: boolean; emitEvents?: boolean;
  showHero: boolean; actorAway: boolean; reducedMotion: boolean;
};

/** Audio follows the visible observer, never the remote persistence lease.
 * One shared delta observer prevents circle/map handoffs replaying footsteps. */
export function createWorldAudioController(runtime: AudioRuntime) {
  const ownerId = `forest-audio-view-${++nextOwner}`;
  let disposed = false, hadFrame = false, lastState: ForestSessionState | undefined;
  let current: AudioFrame | null = null;
  return {
    update(scene: FixedWorldScene, state: ForestSessionState, input: Omit<WorldAudioEnvironment, "ownerId">, control: WorldAudioControl) {
      if (disposed) return;
      if (!control.visible || !control.observationOwner) {
        if (hadFrame) runtime.clearFrame(ownerId);
        hadFrame = false; current = null;
        // Do not let a secondary camera consume the active camera's markers.
        if (control.observationOwner) {
          const tracker = trackers.get(state);
          tracker?.sample(worldAudioMarkers(scene, state, { ...control, showBuildings: input.showBuildings !== false }),
            buildWorldAudioFrame(scene, { ...input, ownerId }).listener, input.sceneId, Date.now(), false);
        }
        return;
      }
      if (lastState && lastState !== state) runtime.clearFrame(ownerId);
      const frame = buildWorldAudioFrame(scene, { ...input, ownerId });
      current = frame;
      runtime.updateFrame(frame);
      let tracker = trackers.get(state);
      if (!tracker) { tracker = createWorldAudioMarkerTracker(); trackers.set(state, tracker); }
      const markers = worldAudioMarkers(scene, state, { ...control, showBuildings: input.showBuildings !== false });
      const events = tracker.sample(markers, frame.listener, input.sceneId, Date.now(), Boolean(control.emitEvents && hadFrame && lastState === state));
      hadFrame = true; lastState = state;
      for (const event of events) runtime.play(event);
    },
    getFrame: () => current,
    dispose() { if (disposed) return; disposed = true; runtime.clearFrame(ownerId); current = null; },
  };
}

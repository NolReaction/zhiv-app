import type { AudioFrame, AudioPoint, AudioRuntime } from "@/features/audio/domain/types";
import { stereoPan } from "@/features/audio/domain/spatial";
import type { FixedWorldScene } from "@/features/world/tiled/types";
import type { ForestSessionState } from "@/features/world/state/forest-session";
import { menuAudioFrame } from "@/features/audio/ui/menu-audio";
import { buildWorldAudioFrame, worldAudioListener, type WorldAudioEnvironment } from "./world-audio-frame";
import { createWorldAudioMarkerTracker, worldAudioMarkers } from "./world-audio-markers";
import { createWorldWaterAudioTracker } from "./world-water-audio";

let nextOwner = 0;
const trackers = new WeakMap<ForestSessionState, ReturnType<typeof createWorldAudioMarkerTracker>>();
const waterTrackers = new WeakMap<ForestSessionState, ReturnType<typeof createWorldWaterAudioTracker>>();
export type WorldAudioControl = {
  scope: "music" | "world";
  visible: boolean; observationOwner: boolean; emitEvents?: boolean;
  showHero: boolean; actorAway: boolean; reducedMotion: boolean;
  waterFish?: "auto" | "on" | "off";
};

function sameAudioFrame(previous: AudioFrame | null, next: AudioFrame): boolean {
  if (!previous || previous.ownerId !== next.ownerId || previous.sceneId !== next.sceneId
    || previous.soundscape !== next.soundscape || previous.musicDuck !== next.musicDuck || previous.loops.length !== next.loops.length) return false;
  const a = previous.listener, b = next.listener;
  if (a.position.x !== b.position.x || a.position.y !== b.position.y || a.zoom !== b.zoom
    || a.viewportWidth !== b.viewportWidth || a.detail !== b.detail) return false;
  if (!previous.loops.every((loop, index) => {
    const other = next.loops[index];
    return loop.id === other.id && loop.cueId === other.cueId && loop.gain === other.gain
      && loop.pan === other.pan && loop.priority === other.priority;
  })) return false;
  const sources = previous.sources ?? [], nextSources = next.sources ?? [];
  return sources.length === nextSources.length && sources.every((source, index) => {
    const other = nextSources[index];
    return source.id === other.id && source.cueId === other.cueId && source.gain === other.gain
      && source.pan === other.pan && source.reason === other.reason;
  });
}

/** Audio follows the visible observer, never the remote persistence lease.
 * One shared delta observer prevents circle/map handoffs replaying footsteps. */
export function createWorldAudioController(runtime: AudioRuntime) {
  const ownerId = `forest-audio-view-${++nextOwner}`;
  let disposed = false, hadFrame = false, lastState: ForestSessionState | undefined;
  let current: AudioFrame | null = null;
  let lastScope: WorldAudioControl["scope"] | undefined;
  let lastPublishedAt = -Infinity;
  let lastTouchAt = -Infinity, touchSequence = 0;
  let preparation: AbortController | undefined;
  const stopPreparation = () => { preparation?.abort(); preparation = undefined; };
  return {
    update(scene: FixedWorldScene, state: ForestSessionState, input: Omit<WorldAudioEnvironment, "ownerId">, control: WorldAudioControl) {
      if (disposed) return;
      if (!control.visible || !control.observationOwner) {
        stopPreparation();
        if (hadFrame) runtime.clearFrame(ownerId);
        hadFrame = false; current = null;
        // Do not let a secondary camera consume the active camera's markers.
        if (control.observationOwner) {
          waterTrackers.get(state)?.reset();
          const tracker = trackers.get(state);
          tracker?.sample(worldAudioMarkers(scene, state, { ...control, showBuildings: input.showBuildings !== false,
            quarryWorking: input.quarryWorking }),
            worldAudioListener(scene, input.camera), input.sceneId, Date.now(), false);
        }
        return;
      }
      if (lastState && lastState !== state) { runtime.clearFrame(ownerId); current = null; stopPreparation(); }
      if (control.scope !== "world") stopPreparation();
      else if (!preparation) {
        preparation = new AbortController();
        // Four short files cover both actors and the mine. Warm them before
        // contact; a slow first decode must never queue an out-of-time impact.
        void runtime.prepare?.(["action.fish.bobber", "action.mine.strike"], { signal: preparation.signal }).catch(() => {});
      }
      // The circle renders the live forest but is still a menu surface. Only
      // the full map requests spatial layers; both reuse the same music keys.
      const frame = control.scope === "world" ? buildWorldAudioFrame(scene, { ...input, ownerId })
        : menuAudioFrame(ownerId, input.sceneId, input.dusk);
      // Simulation, its subscribers and painting may all observe the same tick.
      // Coalesce those copies, retaining a slow heartbeat for failed asset
      // retries and voices awaiting budget. Action contacts still observe every
      // tick even when their ambient mix has not changed.
      const timestamp = Date.now();
      if (!sameAudioFrame(current, frame) || timestamp - lastPublishedAt >= 1000 || timestamp < lastPublishedAt) {
        runtime.updateFrame(frame);
        lastPublishedAt = timestamp;
      }
      current = frame;
      let tracker = trackers.get(state);
      if (!tracker) { tracker = createWorldAudioMarkerTracker(); trackers.set(state, tracker); }
      const markers = worldAudioMarkers(scene, state, { ...control, showBuildings: input.showBuildings !== false,
        quarryWorking: input.quarryWorking });
      const emit = Boolean(control.scope === "world" && lastScope === "world" && control.emitEvents && hadFrame && lastState === state);
      const events = tracker.sample(markers, frame.listener, input.sceneId, timestamp, emit);
      if (control.scope === "world") {
        let water = waterTrackers.get(state);
        if (!water) { water = createWorldWaterAudioTracker(); waterTrackers.set(state, water); }
        events.push(...water.sample({ epoch: state.clearing, scene, options: { elapsed: state.elapsed,
          rain: input.rain, dusk: input.dusk, reducedMotion: control.reducedMotion, waterFish: control.waterFish } },
        frame.listener, input.camera, input.sceneId, timestamp, emit));
      } else waterTrackers.get(state)?.reset();
      hadFrame = true; lastState = state; lastScope = control.scope;
      for (const event of events) runtime.play(event);
    },
    /** Call only after a visible water tap was accepted by the scene. Explicit
     * feedback keeps a fixed quiet gain; zoom affects its gentle pan only. */
    touchWater(point: AudioPoint): boolean {
      if (disposed || !current || current.soundscape === false || lastScope !== "world"
        || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
      const timestamp = Date.now();
      if (timestamp >= lastTouchAt && timestamp - lastTouchAt < 180) return false;
      lastTouchAt = timestamp;
      runtime.play({ id: `${current.sceneId}:${ownerId}:water-touch:${++touchSequence}`, cueId: "action.water.touch",
        ownerId, occurredAt: timestamp, maxAgeMs: 180, gain: 1, pan: stereoPan(point, current.listener) * .45 });
      return true;
    },
    getFrame: () => current,
    dispose() { if (disposed) return; disposed = true; stopPreparation(); runtime.clearFrame(ownerId); current = null; },
  };
}

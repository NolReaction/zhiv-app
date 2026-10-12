import type { AudioEvent, AudioListenerFrame, AudioPoint } from "@/features/audio/domain/types";
import type { FixedWorldScene } from "@/features/world/tiled/types";
import { forestWaterContactsFrame, type WaterOptions } from "@/features/world/environment/water/forest-water";
import { worldAudioEventPosition, type WorldAudioCamera } from "./world-audio-frame";

export const WATER_AUDIO_INTERVAL = 1.2;
let nextSession = 0;
type WaterAudioSnapshot = { epoch: object; scene: FixedWorldScene; options: WaterOptions };
type Candidate = { id: string; gain: number; pan: number };

/** A few visible contacts punctuate the river bed. Every ring is observed before
 * camera filtering, so panning onto an old ripple cannot make it sound again. */
export function createWorldWaterAudioTracker() {
  const session = ++nextSession;
  let previous: { snapshot: WaterAudioSnapshot; ids: Set<string> } | null = null;
  let lastContactAt = -Infinity, sequence = 0;
  return {
    reset() { previous = null; lastContactAt = -Infinity; },
    sample(snapshot: WaterAudioSnapshot, listener: AudioListenerFrame, camera: WorldAudioCamera | undefined,
      scope: string, now: number, emit = true): AudioEvent[] {
      const { scene, options } = snapshot, before = previous;
      const old = before?.snapshot;
      // Simulation, subscription and camera painting can observe one clock.
      // Their copies neither recompute the particles nor turn panning into a hit.
      if (old?.epoch === snapshot.epoch && old.scene === scene && old.options.elapsed === options.elapsed
        && old.options.rain === options.rain && old.options.dusk === options.dusk
        && old.options.reducedMotion === options.reducedMotion && old.options.waterFish === options.waterFish) return [];
      const restarted = !old || old.epoch !== snapshot.epoch || old.scene !== scene || options.elapsed < old.options.elapsed;
      if (restarted) lastContactAt = -Infinity;
      const delta = old ? options.elapsed - old.options.elapsed : 0;
      const audible = !restarted && emit && !options.reducedMotion && camera && delta > 0 && delta <= .25
        && options.elapsed - lastContactAt >= WATER_AUDIO_INTERVAL;
      const height = camera && Number.isFinite(camera.viewportHeight) && camera.viewportHeight! > 0
        ? camera.viewportHeight! / listener.zoom : listener.viewportWidth;
      const frame = forestWaterContactsFrame(scene, options), ids = new Set<string>();
      let candidate: Candidate | null = null;
      const observe = (point: AudioPoint & { phase: number }, id: string) => {
        ids.add(id);
        if (!audible || before?.ids.has(id) || point.phase > .12
          || Math.abs(point.x - listener.position.x) >= listener.viewportWidth / 2
          || Math.abs(point.y - listener.position.y) >= height / 2) return;
        const spatial = worldAudioEventPosition(point, listener);
        if (spatial.gain > .06 && (!candidate || spatial.gain > candidate.gain)) candidate = { id, ...spatial };
      };
      for (const point of frame.impacts) observe(point, `drop:${point.eventId}`);
      for (const point of frame.splashes) observe(point, `splash:${point.id}`);
      previous = { snapshot, ids };
      // Consume all other simultaneous contacts without a queue, even in a storm.
      const contact = candidate as Candidate | null;
      if (!contact) return [];
      lastContactAt = options.elapsed;
      return [{ id: `${scope}:water-${session}:${++sequence}:${contact.id}`, cueId: "water.drop", occurredAt: now,
        gain: contact.gain, pan: contact.pan, maxAgeMs: 250 }];
    },
  };
}

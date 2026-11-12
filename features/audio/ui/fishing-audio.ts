import { fishingRiverNightBlend, type FishingRiverAmbience } from "./fishing-river-mix";
import type { AudioFrame, AudioRuntime } from "@/features/audio/domain/types";

export type FishingAudioState = {
  sceneId: string; voyageId: string;
  stage: "waiting" | "casting" | "soaking" | "landed" | "bite" | "reeling" | "paused" | "caught" | "escaped" | "expired" | "pending";
  ambience?: FishingRiverAmbience;
  castKey?: string; held: boolean; progress: number; inZone: boolean; caughtCount: number; suspended?: boolean;
};
export const FISHING_AUDIO_CUES = ["music.fishing", "fishing.cast", "fishing.bite", "fishing.reel", "fishing.reel.wind", "fishing.reel.slack", "fishing.escape", "fishing.catch", "action.fish.splash", "river", "fishing.hull", "fishing.reeds", "forest.day", "forest.night"] as const;

/** Two quiet, stable voices crossfade with input. The shared runtime smooths their gain without restarting either loop. */
export function fishingReelLoopMix(state: Pick<FishingAudioState, "stage" | "castKey" | "voyageId" | "held" | "progress" | "inZone" | "suspended">) {
  if (state.stage !== "reeling" || state.suspended || !state.castKey) return [];
  const progress = Number.isFinite(state.progress) ? Math.max(0, Math.min(1, Math.round(state.progress / 500) / 20)) : 0;
  const wind = state.held ? (state.inZone ? .43 : .25) + progress * .12 : .002;
  const slack = state.held ? .002 : (state.inZone ? .29 : .38) + progress * .08;
  return [
    { id: `fishing-reel-wind:${state.voyageId}:${state.castKey}`, cueId: "fishing.reel.wind", gain: wind, pan: -.025 },
    { id: `fishing-reel-slack:${state.voyageId}:${state.castKey}`, cueId: "fishing.reel.slack", gain: slack, pan: .025 },
  ];
}

/** Same account/world scene keeps the outdoor music position across the handoff. */
export function fishingAudioFrame(ownerId: string, state: FishingAudioState): AudioFrame {
  const quiet = state.stage === "paused" ? .55 : 1;
  const night = fishingRiverNightBlend(state.ambience);
  const loops = [
    { id: "music-fishing:music.fishing", cueId: "music.fishing", gain: .65, pan: 0 },
    { id: "fishing-river", cueId: "river", gain: .12 * quiet, pan: .04 },
    { id: "fishing-reeds", cueId: "fishing.reeds", gain: .36 * quiet, pan: .18 },
    { id: "fishing-day-birds", cueId: "forest.day", gain: .65 * (1 - night) * quiet, pan: -.22 },
    { id: "fishing-night-insects", cueId: "forest.night", gain: .28 * night * quiet, pan: .12 },
    ...fishingReelLoopMix(state),
  ].filter(loop => loop.gain > .0001);
  return { ownerId, sceneId: state.sceneId, soundscape: true,
    listener: { position: { x: 0, y: 0 }, viewportWidth: 1, zoom: 1, detail: 1 },
    loops, musicDuck: state.stage === "paused" ? .55 : 1,
    sources: loops.map(loop => ({ ...loop, reason: "fishing" })) };
}

/** A completed fight increases the displayed catch count. Its later receipt keeps the same count. */
export function createFishingAudioController(runtime: AudioRuntime, ownerId: string, clock = {
  now: () => Date.now(), schedule: (callback: () => void, ms: number) => setTimeout(callback, ms),
  cancel: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
}) {
  let previous: FishingAudioState | null = null, current: FishingAudioState | null = null;
  let retained = false, disposed = false, lastDuck = -1, lastScene = "", lastMix = "", milestone = 0;
  let nextCreakAt = Infinity, lastAmbientAt = 0, creakSequence = 0;
  let lastReelAt = -Infinity, splashTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelSplash = () => { if (splashTimer !== undefined) clock.cancel(splashTimer); splashTimer = undefined; };
  const emit = (cueId: string, suffix: string, gain = 1) => {
    if (!current || current.suspended || disposed) return;
    runtime.play({ id: `${ownerId}:${current.voyageId}:${current.castKey ?? "idle"}:${suffix}`,
      cueId, ownerId, occurredAt: clock.now(), maxAgeMs: 250, gain });
  };
  return {
    update(next: FishingAudioState) {
      if (disposed) return;
      current = { ...next };
      const replaced = previous?.sceneId !== next.sceneId || previous?.voyageId !== next.voyageId;
      const freshCast = !replaced && Boolean(next.castKey && next.castKey !== previous?.castKey);
      const changedAttempt = replaced || previous?.castKey !== next.castKey;
      const reachedMilestone = Math.floor(next.progress / 2500);
      // A slip or visibility handoff cannot lower this attempt's consumed high-water mark.
      if (changedAttempt) milestone = reachedMilestone;
      const resumed = Boolean(previous?.suspended && !next.suspended);
      if (replaced || previous?.castKey !== next.castKey || next.suspended || next.stage === "paused") cancelSplash();
      if (next.suspended) {
        nextCreakAt = Infinity; lastAmbientAt = clock.now();
        if (retained) runtime.clearFrame(ownerId);
        retained = false; previous = { ...next }; milestone = Math.max(milestone, reachedMilestone);
        return;
      }
      const frame = fishingAudioFrame(ownerId, next);
      const mix = frame.loops.map(loop => `${loop.id}:${loop.gain}`).join("|");
      if (!retained || lastDuck !== frame.musicDuck || lastScene !== next.sceneId || lastMix !== mix) {
        runtime.updateFrame(frame); retained = true; lastDuck = frame.musicDuck; lastScene = next.sceneId; lastMix = mix;
      }
      if (replaced || resumed) {
        milestone = Math.max(milestone, reachedMilestone);
      } else {
        if (freshCast && next.stage !== "paused" && next.stage !== "expired") {
          milestone = reachedMilestone; lastReelAt = -Infinity;
          emit("fishing.cast", "cast");
          const castKey = next.castKey;
          splashTimer = clock.schedule(() => {
            splashTimer = undefined;
            const active = current;
            if (active && active.castKey === castKey && !active.suspended && active.stage !== "paused") emit("action.fish.splash", "cast-splash", .5);
          }, 1200);
        }
        if (next.stage === "bite" && (previous?.stage === "casting" || previous?.stage === "soaking")) emit("fishing.bite", "bite");
        if (next.stage === "escaped" && previous?.stage !== "escaped") emit("fishing.escape", "escape");
        if (next.caughtCount > (previous?.caughtCount ?? next.caughtCount)) emit("fishing.catch", `confirmed-${next.caughtCount}`);
        const reached = Math.floor(next.progress / 2500);
        if (reached > milestone) {
          if (next.stage === "reeling" && next.held && next.inZone && clock.now() - lastReelAt >= 450) {
            emit("fishing.reel", `reel-${reached}`, .3); lastReelAt = clock.now();
          }
          milestone = reached;
        }
      }
      const ambienceNow = clock.now();
      if (next.stage === "paused") nextCreakAt = Infinity;
      else {
        // Poll-driven sparse contacts need no timer and never backfill after a stall/background.
        const wait = () => 18000 + (next.voyageId.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0) * 37 + creakSequence * 5171) % 12000;
        if (replaced || resumed || !Number.isFinite(nextCreakAt) || ambienceNow - lastAmbientAt > 2500 || ambienceNow < lastAmbientAt) nextCreakAt = ambienceNow + wait();
        else if (ambienceNow >= nextCreakAt) {
          emit("fishing.hull", `hull-${creakSequence++}`, .55);
          nextCreakAt = ambienceNow + wait();
        }
      }
      lastAmbientAt = ambienceNow;
      previous = { ...next };
    },
    dispose() {
      if (disposed) return;
      disposed = true; cancelSplash();
      if (retained) runtime.clearFrame(ownerId);
      retained = false; previous = null; current = null;
    },
  };
}

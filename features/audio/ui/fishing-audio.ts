import type { AudioFrame, AudioRuntime } from "@/features/audio/domain/types";

export type FishingAudioState = {
  sceneId: string; voyageId: string;
  stage: "waiting" | "casting" | "soaking" | "landed" | "bite" | "reeling" | "paused" | "caught" | "escaped" | "expired" | "pending";
  castKey?: string; held: boolean; progress: number; inZone: boolean; caughtCount: number; suspended?: boolean;
};
export const FISHING_AUDIO_CUES = ["music.fishing", "fishing.cast", "fishing.bite", "fishing.reel", "fishing.escape", "fishing.catch", "action.fish.splash"] as const;

/** Same account/world scene keeps the outdoor music position across the handoff. */
export function fishingAudioFrame(ownerId: string, state: FishingAudioState): AudioFrame {
  const loops = [{ id: "music-fishing:music.fishing", cueId: "music.fishing", gain: .65, pan: 0 }];
  return { ownerId, sceneId: state.sceneId, soundscape: true,
    listener: { position: { x: 0, y: 0 }, viewportWidth: 1, zoom: 1, detail: 1 },
    loops, musicDuck: state.stage === "paused" ? .55 : 1,
    sources: loops.map(loop => ({ ...loop, reason: "fishing" })) };
}

/** Feedback observes public state; only an increased confirmed catch count sounds a reward. */
export function createFishingAudioController(runtime: AudioRuntime, ownerId: string, clock = {
  now: () => Date.now(), schedule: (callback: () => void, ms: number) => setTimeout(callback, ms),
  cancel: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
}) {
  let previous: FishingAudioState | null = null, current: FishingAudioState | null = null;
  let retained = false, disposed = false, lastDuck = -1, lastScene = "", milestone = 0;
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
      const resumed = Boolean(previous?.suspended && !next.suspended);
      if (replaced || previous?.castKey !== next.castKey || next.suspended || next.stage === "paused") cancelSplash();
      if (next.suspended) {
        if (retained) runtime.clearFrame(ownerId);
        retained = false; previous = { ...next }; milestone = Math.floor(next.progress / 1000);
        return;
      }
      const frame = fishingAudioFrame(ownerId, next);
      if (!retained || lastDuck !== frame.musicDuck || lastScene !== next.sceneId) {
        runtime.updateFrame(frame); retained = true; lastDuck = frame.musicDuck; lastScene = next.sceneId;
      }
      if (replaced || resumed) {
        milestone = Math.floor(next.progress / 1000);
      } else {
        if (freshCast && next.stage !== "paused" && next.stage !== "expired") {
          milestone = 0; lastReelAt = -Infinity;
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
        const reached = Math.floor(next.progress / 1000);
        if (reached > milestone) {
          if (next.stage === "reeling" && next.held && next.inZone && clock.now() - lastReelAt >= 450) {
            emit("fishing.reel", `reel-${reached}`, .7); lastReelAt = clock.now();
          }
          milestone = reached;
        }
      }
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

import type { AudioFrame, AudioRuntime } from "@/features/audio/domain/types";

export type MenuAudioState = { active: boolean; handoff?: boolean; sceneId: string | null; night: boolean };

/** Share the forest's deck keys: opening a menu changes the mix, not the song's position. */
export function menuAudioFrame(ownerId: string, sceneId: string, night: boolean): AudioFrame {
  const cueId = night ? "music.night" : "music.day";
  return {
    ownerId, sceneId,
    listener: { position: { x: 0, y: 0 }, viewportWidth: 1, zoom: 1, detail: 0 },
    loops: [{ id: night ? "music-night:music.night" : "music-day:music.day", cueId, gain: .65, pan: 0 }],
    musicDuck: 1,
    sources: [{ id: "menu-music", cueId, gain: .65, pan: 0, reason: "menu" }],
  };
}

/** Updates follow meaningful view/time changes; polls and React rerenders never restart audio. */
export function createMenuAudioController(runtime: AudioRuntime, ownerId: string) {
  let previous: MenuAudioState | null = null;
  let retainedSceneId: string | null = null;
  let disposed = false;
  return {
    update(next: MenuAudioState) {
      if (disposed) return;
      if (!next.active || !next.sceneId) {
        // A lazily loaded forest can take longer than the runtime's brief canvas
        // handoff window. Keep its existing music until the ready forest takes
        // ownership, but never keep an old account or inactive app sounding.
        if (next.handoff && next.sceneId && retainedSceneId === next.sceneId) {
          previous = null;
          return;
        }
        if (retainedSceneId) runtime.clearFrame(ownerId);
        retainedSceneId = null;
        previous = null;
        return;
      }
      if (previous?.sceneId === next.sceneId && previous.night === next.night) return;
      runtime.updateFrame(menuAudioFrame(ownerId, next.sceneId, next.night));
      retainedSceneId = next.sceneId;
      previous = { ...next };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (retainedSceneId) runtime.clearFrame(ownerId);
      retainedSceneId = null;
      previous = null;
    },
  };
}

/** Audio contracts contain no browser, React or world state dependencies. */
export type AudioBus = "music" | "ambience" | "weather" | "world" | "footsteps" | "characters" | "ui";
export const AUDIO_BUSES: readonly AudioBus[] = ["music", "ambience", "weather", "world", "footsteps", "characters", "ui"];
export type AudioPoint = { x: number; y: number };
export type AudioSettings = { enabled: boolean; master: number; buses: Record<AudioBus, number> };
export type AudioLicense = { name: string; url: string; author: string; sourceUrl: string; acquiredAt: string; changes: string; attribution: string };
export type AudioAsset = {
  id: string; src: string | null; fallbackSrc?: string; status: "pending" | "ready";
  license: AudioLicense | null; loopStart?: number; loopEnd?: number;
};
export type AudioCue = {
  id: string; bus: AudioBus; mode: "one-shot" | "loop" | "music";
  assets: string[]; gainDb: number; priority: number; maxInstances: number;
  cooldownMs: number; pitchVariation: number; fadeMs: number;
};
export type AudioProfile = { id: string; cues: string[] };
export type AudioCatalog = { version: number; assets: AudioAsset[]; cues: AudioCue[]; profiles: AudioProfile[] };
export type AudioListenerFrame = { position: AudioPoint; viewportWidth: number; zoom: number; detail: number };
export type AudioLoopTarget = { id: string; cueId: string; gain: number; pan: number; priority?: number };
export type AudioEvent = {
  id: string; cueId: string; gain?: number; pan?: number; occurredAt?: number;
  /** Short animation contacts may expire before the runtime's normal event TTL. */
  maxAgeMs?: number;
  playbackRate?: number; feedbackBus?: AudioBus | "master";
};
export type AudioSourceDebug = { id: string; cueId: string; gain: number; pan: number; reason: string };
export type AudioFrame = {
  ownerId: string; sceneId: string; listener: AudioListenerFrame;
  loops: AudioLoopTarget[]; musicDuck: number; sources?: AudioSourceDebug[];
  /** False outside the full map: keep music/UI, fade and suppress scene sounds. */
  soundscape?: boolean;
};
export type AudioRuntimeState = "locked" | "running" | "suspended" | "unavailable" | "disposed";
export type AudioDiagnostics = {
  state: AudioRuntimeState; settings: AudioSettings; activeVoices: number;
  loadedAssets: number; pendingAssets: number; failedAssets: string[];
  sources: AudioSourceDebug[]; lastEvent: string | null; droppedEvents: number;
  playback?: { loopStarts: number; musicStarts: number; activeOwnerId: string | null };
};
export type AudioSettingsPatch = Partial<Omit<AudioSettings, "buses">> & { buses?: Partial<Record<AudioBus, number>> };

export interface AudioRuntime {
  unlock(): Promise<boolean>;
  /** Prepare resources without waiting for browser playback permission. */
  prepare(cueIds: readonly string[], options?: { signal?: AbortSignal }): Promise<void>;
  setSettings(patch: AudioSettingsPatch): void;
  getSettings(): AudioSettings;
  updateFrame(frame: AudioFrame): void;
  clearFrame(ownerId: string): void;
  play(event: AudioEvent): void;
  preview(cueId: string): void;
  previewTone(bus?: AudioBus): void;
  setVisible(visible: boolean): void;
  getDiagnostics(): AudioDiagnostics;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

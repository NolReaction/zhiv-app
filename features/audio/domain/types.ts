/** Audio contracts contain no browser, React or world state dependencies. */
export type AudioBus = "music" | "ambience" | "world" | "characters" | "ui";
export const AUDIO_BUSES: readonly AudioBus[] = ["music", "ambience", "world", "characters", "ui"];
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
};
export type AudioSourceDebug = { id: string; cueId: string; gain: number; pan: number; reason: string };
export type AudioFrame = {
  ownerId: string; sceneId: string; listener: AudioListenerFrame;
  loops: AudioLoopTarget[]; musicDuck: number; sources?: AudioSourceDebug[];
};
export type AudioRuntimeState = "locked" | "running" | "suspended" | "unavailable" | "disposed";
export type AudioDiagnostics = {
  state: AudioRuntimeState; settings: AudioSettings; activeVoices: number;
  loadedAssets: number; pendingAssets: number; failedAssets: string[];
  sources: AudioSourceDebug[]; lastEvent: string | null; droppedEvents: number;
};
export type AudioSettingsPatch = Partial<Omit<AudioSettings, "buses">> & { buses?: Partial<Record<AudioBus, number>> };

export interface AudioRuntime {
  unlock(): Promise<boolean>;
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

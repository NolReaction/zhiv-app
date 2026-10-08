import { AUDIO_BUSES, type AudioSettings, type AudioSettingsPatch } from "./types";

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  enabled: false, master: 0.65,
  buses: { music: 0.4, ambience: 0.65, world: 0.65, characters: 0.6, ui: 0.5 },
};
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const volume = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;

/** Storage is untrusted, including old versions and incomplete preferences. */
export function sanitizeAudioSettings(value: unknown): AudioSettings {
  const source = object(value), buses = object(source.buses);
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_AUDIO_SETTINGS.enabled,
    master: volume(source.master, DEFAULT_AUDIO_SETTINGS.master),
    buses: Object.fromEntries(AUDIO_BUSES.map(bus => [bus, volume(buses[bus], DEFAULT_AUDIO_SETTINGS.buses[bus])])) as AudioSettings["buses"],
  };
}

export function mergeAudioSettings(current: AudioSettings, patch: AudioSettingsPatch): AudioSettings {
  return sanitizeAudioSettings({ ...current, ...patch, buses: { ...current.buses, ...patch.buses } });
}

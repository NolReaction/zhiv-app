import { AUDIO_BUSES, type AudioSettings, type AudioSettingsPatch } from "./types";

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  enabled: true, master: 0.65,
  buses: { music: 0.1, ambience: 0.4, weather: 0.3, world: 0.55, footsteps: 0.25, characters: 0.5, ui: 1 },
};

/** Restore the mix without changing the player's explicit sound permission. */
export function getDefaultAudioVolumePatch(): Pick<AudioSettings, "master" | "buses"> {
  return { master: DEFAULT_AUDIO_SETTINGS.master, buses: { ...DEFAULT_AUDIO_SETTINGS.buses } };
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const volume = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;

/** Storage is untrusted, including old versions and incomplete preferences. */
export function sanitizeAudioSettings(value: unknown): AudioSettings {
  const source = object(value), buses = object(source.buses);
  // Weather previously shared ambience. Splitting it must never restore a
  // silenced forest or increase a player's already quiet environmental mix.
  const weatherFallback = Math.min(volume(buses.ambience, DEFAULT_AUDIO_SETTINGS.buses.weather), DEFAULT_AUDIO_SETTINGS.buses.weather);
  // Footsteps used to belong to world actions. Preserve an explicit mute or
  // quieter world mix when introducing their independent device slider.
  const footstepsFallback = Math.min(volume(buses.world, DEFAULT_AUDIO_SETTINGS.buses.footsteps), DEFAULT_AUDIO_SETTINGS.buses.footsteps);
  const fallback = { ...DEFAULT_AUDIO_SETTINGS.buses, weather: weatherFallback, footsteps: footstepsFallback };
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_AUDIO_SETTINGS.enabled,
    master: volume(source.master, DEFAULT_AUDIO_SETTINGS.master),
    buses: Object.fromEntries(AUDIO_BUSES.map(bus => [bus, volume(buses[bus], fallback[bus])])) as AudioSettings["buses"],
  };
}

export function mergeAudioSettings(current: AudioSettings, patch: AudioSettingsPatch): AudioSettings {
  return sanitizeAudioSettings({ ...current, ...patch, buses: { ...current.buses, ...patch.buses } });
}

import { sanitizeAudioSettings } from "@/features/audio/domain/settings";
import type { AudioRuntime } from "@/features/audio/domain/types";
import { createAudioRuntime } from "./audio-runtime";

export const AUDIO_SETTINGS_STORAGE_KEY = "zhiv:audio-settings:v1";
let browserRuntime: AudioRuntime | null = null;

/** No context, DOM, storage or shared account state is acquired while importing this module. */
export function getAudioRuntime(): AudioRuntime {
  if (typeof window === "undefined") return createAudioRuntime();
  if (browserRuntime && browserRuntime.getDiagnostics().state !== "disposed") return browserRuntime;
  let saved: unknown;
  try { saved = JSON.parse(window.localStorage.getItem(AUDIO_SETTINGS_STORAGE_KEY) ?? "null"); } catch { /* Storage is optional in private mode. */ }
  const runtime = createAudioRuntime({ initialSettings: sanitizeAudioSettings(saved) });
  let lastSettings = runtime.getSettings();
  runtime.subscribe(() => {
    const settings = runtime.getSettings();
    if (settings === lastSettings) return;
    lastSettings = settings;
    try { window.localStorage.setItem(AUDIO_SETTINGS_STORAGE_KEY, JSON.stringify(settings)); } catch { /* Settings still work for this session. */ }
  });
  browserRuntime = runtime;
  return runtime;
}

"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_AUDIO_SETTINGS } from "@/features/audio/domain/settings";
import type { AudioDiagnostics } from "@/features/audio/domain/types";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";

const SERVER_SNAPSHOT: AudioDiagnostics = {
  state: "locked", settings: DEFAULT_AUDIO_SETTINGS, activeVoices: 0, loadedAssets: 0,
  pendingAssets: 0, failedAssets: [], sources: [], lastEvent: null, droppedEvents: 0,
};
const subscribe = (listener: () => void) => getAudioRuntime().subscribe(listener);
const snapshot = () => getAudioRuntime().getDiagnostics();
const serverSnapshot = () => SERVER_SNAPSHOT;

export function useAudioDiagnostics() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

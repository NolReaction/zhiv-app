import catalog from "./audio-catalog.json";
import type { AudioCatalog } from "@/features/audio/domain/types";

/** Pending entries reserve stable IDs without requesting nonexistent sound files. */
export const AUDIO_CATALOG = catalog as AudioCatalog;
const cues = new Map(AUDIO_CATALOG.cues.map(cue => [cue.id, cue]));
const profiles = new Map(AUDIO_CATALOG.profiles.map(profile => [profile.id, profile]));
export const audioCue = (id: string) => cues.get(id);
export const profileCues = (id: string) => (profiles.get(id)?.cues ?? []).flatMap(cueId => {
  const cue = cues.get(cueId); return cue ? [cue] : [];
});

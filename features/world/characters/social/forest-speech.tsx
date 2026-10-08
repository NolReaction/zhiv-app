"use client";

import { useCallback, useSyncExternalStore } from "react";
import { getForestObservation, subscribeForestObservation, type ForestSpeechObservation } from "@/features/world/state/forest-observer";
import type { ForestSpeaker } from "./forest-social";
import { BUILDER } from "@/features/world/characters/builder/builder-types";
import styles from "./forest-speech.module.css";

const names: Record<ForestSpeaker, string> = { mochlik: "Мохлик", plesk: "Плёска", builder: BUILDER.name };
const noSpeech = (): null => null;

/** React only reads the active scene line; it cannot start or advance a conversation. */
function useForestSpeech(owner: string | undefined) {
  const key = owner ? `zhiv:mochlik:presence:${owner}` : undefined;
  const subscribe = useCallback((listener: () => void) => subscribeForestObservation(key, listener), [key]);
  const snapshot = useCallback(() => getForestObservation(key)?.speech ?? null, [key]);
  return useSyncExternalStore(subscribe, snapshot, noSpeech);
}

export function ForestSpeechBubble({ speech }: { speech: ForestSpeechObservation }) {
  return <p key={speech.id} className={styles.bubble} role="status" aria-live="polite" aria-atomic="true" data-forest-speaker={speech.speaker}>
    <span className={styles.hidden}>{names[speech.speaker]}: </span>{speech.text}
  </p>;
}

/** A map tap still opens the shop/work dialog, where its brief reply remains visible. */
export function ResidentSpeech({ owner, speaker }: { owner: string | undefined; speaker: ForestSpeaker }) {
  const speech = useForestSpeech(owner);
  return speech?.speaker === speaker ? <ForestSpeechBubble key={speech.id} speech={speech} /> : null;
}

/** Canvas text has no accessibility tree; announce each semantic line only once. */
export function ForestSpeechAnnouncements({ owner }: { owner: string }) {
  const speech = useForestSpeech(owner);
  return <span className={styles.hidden} role="status" aria-live="polite" aria-atomic="true">
    {speech ? `${names[speech.speaker]}: ${speech.text}` : ""}
  </span>;
}

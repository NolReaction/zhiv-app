"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import { GuidePortrait } from "./guide-portrait";
import { GUIDE_REACTION_DURATION_MS, guidePortraitReaction } from "./guide-portrait-animation";
import styles from "./guide-coach.module.css";

const subscribeVisibility = (listener: () => void) => {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};
const documentVisible = () => document.visibilityState !== "hidden";
const serverVisible = () => true;

/** This little greeting owns no progression callbacks and never sends a game
 * command. Native button activation also makes it available from the keyboard. */
export function GuideCharacter({ pose, stepId }: { pose: PixelPose; stepId: string }) {
  const [reaction, setReaction] = useState<{ id: number; pose: PixelPose; text: string } | null>(null);
  const taps = useRef(0);
  const visible = useSyncExternalStore(subscribeVisibility, documentVisible, serverVisible);
  useEffect(() => {
    if (!reaction) return;
    let remaining = GUIDE_REACTION_DURATION_MS, started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resume = () => {
      if (timer !== undefined) {
        remaining = Math.max(0, remaining - (performance.now() - started));
        clearTimeout(timer);
        timer = undefined;
      }
      if (document.visibilityState === "hidden") return;
      started = performance.now();
      timer = setTimeout(() => setReaction(null), remaining);
    };
    resume();
    document.addEventListener("visibilitychange", resume);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", resume); };
  }, [reaction]);
  const reacting = reaction !== null;
  const celebration = reacting ? reaction.pose === "jump" : pose === "jump";
  return <button type="button" className={styles.character} aria-label="Погладить Мохлика" title="Погладить Мохлика"
    data-guide-character data-reaction={reaction?.id ?? "arrival"} data-paused={!visible}
    onKeyDown={event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }}
    onClick={event => {
      event.stopPropagation();
      const index = taps.current++;
      setReaction({ id: index, ...guidePortraitReaction(index) });
    }}>
    <span key={`${stepId}:${reaction?.id ?? "arrival"}`} className={styles.characterGesture} data-jump={celebration} aria-hidden="true">
      <GuidePortrait pose={reaction?.pose ?? pose} stepId={`${stepId}:${reaction?.id ?? "arrival"}`} className={styles.portrait} />
      {celebration && <span className={styles.sparkles}><i /><i /><i /><i /></span>}
    </span>
    <span className={styles.characterSpeech} role="status" aria-live="polite" aria-atomic="true">{reaction?.text ?? ""}</span>
  </button>;
}

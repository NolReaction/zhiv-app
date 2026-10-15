"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./fish-tap-feedback.module.css";

export type FishTapFeedback = { itemId: string; kind: "added" | "limit"; sequence: number; quantity?: number };
export const FISH_TAP_FEEDBACK_MS = 620;

/** Event feedback is scoped to the displayed owner's active stock surface. */
export function useFishTapFeedback(scope: string) {
  const [event, setEvent] = useState<(FishTapFeedback & { scope: string }) | null>(null);
  const sequence = useRef(0);
  useEffect(() => {
    if (!event) return;
    const timeout = setTimeout(() => setEvent(current => current?.sequence === event.sequence ? null : current), FISH_TAP_FEEDBACK_MS);
    return () => clearTimeout(timeout);
  }, [event]);
  return {
    feedback: event?.scope === scope ? event : null,
    show(itemId: string, kind: FishTapFeedback["kind"], quantity?: number) {
      setEvent({ scope, itemId, kind, quantity, sequence: ++sequence.current });
    },
    clear() { setEvent(null); },
  };
}

type Props = { feedback?: FishTapFeedback | null; itemId: string; children: ReactNode };
const matching = (feedback: Props["feedback"], itemId: string) => feedback?.itemId === itemId ? feedback : null;

/** Stable artwork plus an absolute event badge; no card or focus target remounts. */
export function FishTapFeedbackArt({ feedback, itemId, children }: Props) {
  const event = matching(feedback, itemId);
  return <span className={styles.art} data-fish-tap-art data-fish-tap-kind={event?.kind}
    data-fish-tap-sequence={event?.sequence} data-flash={event ? event.sequence % 2 ? "odd" : "even" : undefined}>
    {children}
    {event && <span key={event.sequence} className={styles.badge} data-fish-tap-badge={event.kind} aria-hidden="true">{event.kind === "added" ? "+1" : "Лимит"}</span>}
  </span>;
}

/** Only a keyed overlay pulses; the input stays mounted even when feedback ends. */
export function FishTapFeedbackQuantity({ feedback, itemId, children }: Props) {
  const event = matching(feedback, itemId);
  return <span className={styles.quantity} data-fish-tap-quantity>
    {children}
    {event && <span key={event.sequence} className={styles.quantityPulse} data-fish-quantity-pulse={event.kind} aria-hidden="true" />}
    <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">{event && <span key={event.sequence}>
      {event.kind === "added" ? "Добавлена одна рыба." : "Достигнут лимит."}{event.quantity !== undefined ? ` Выбрано: ${event.quantity}.` : ""}
    </span>}</span>
  </span>;
}

"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { Leaf, Sparkles } from "lucide-react";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import type { PlayerXpGain } from "@/features/economy/domain/player-xp-gain";
import { createPlayerXpPlayback } from "./player-xp-playback";
import styles from "./player-xp-feedback.module.css";

const NO_GAINS: readonly PlayerXpGain[] = [];

/** Mount once with the account. Existing receipts are the baseline, not an animation queue. */
export function PlayerXpFeedback({ economy, active = true }: { economy: EconomyController; active?: boolean }) {
  const owner = economy.snapshot?.ownerPublicId ?? null, gains = economy.playerXpGains ?? NO_GAINS;
  const card = useRef<HTMLDivElement>(null), amount = useRef<HTMLSpanElement>(null), level = useRef<HTMLSpanElement>(null);
  const animation = useRef<Animation | null>(null);
  const playback = useRef<ReturnType<typeof createPlayerXpPlayback> | null>(null);
  useLayoutEffect(() => {
    if (!playback.current) playback.current = createPlayerXpPlayback(owner, gains, {
      show(burst, entering) {
        if (!card.current || !amount.current || !level.current || document.hidden) return;
        card.current.hidden = false;
        amount.current.textContent = `+${burst.xp.toLocaleString("ru-RU")} XP`;
        level.current.textContent = burst.toLevel > burst.fromLevel ? `Уровень ${burst.toLevel}!` : "Опыт развития";
        card.current.dataset.levelUp = String(burst.toLevel > burst.fromLevel);
        if (entering && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          animation.current?.cancel();
          animation.current = card.current.animate?.([
            { opacity: 0, transform: "translateY(7px) scale(.96)" },
            { opacity: 1, transform: "translateY(0) scale(1)" },
          ], { duration: 280, easing: "cubic-bezier(.2,.8,.3,1)" }) ?? null;
        }
      },
      hide() { animation.current?.cancel(); animation.current = null; if (card.current) card.current.hidden = true; },
      now: () => performance.now(), schedule: (finish, milliseconds) => setTimeout(finish, milliseconds),
      cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    });
    playback.current.receive(owner, gains, active && !document.hidden);
  }, [owner, gains, active]);
  useEffect(() => {
    const visibility = () => { if (document.hidden) playback.current?.clear(); };
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const changedMotion = () => { if (motion.matches) animation.current?.cancel(); };
    document.addEventListener("visibilitychange", visibility); motion.addEventListener("change", changedMotion);
    return () => { document.removeEventListener("visibilitychange", visibility); motion.removeEventListener("change", changedMotion); playback.current?.clear(); };
  }, []);
  return <div className={styles.layer} aria-live="polite" aria-atomic="true" data-player-xp-feedback>
    <div className={styles.card} ref={card} hidden>
      <span className={styles.emblem} aria-hidden="true"><Leaf size={19} /><Sparkles size={10} /></span>
      <span className={styles.amount} ref={amount} /><span className={styles.level} ref={level} />
    </div>
  </div>;
}

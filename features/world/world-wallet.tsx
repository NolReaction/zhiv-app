"use client";

import { useLayoutEffect, useRef } from "react";
import { ItemIcon } from "@/features/items/item-icon";
import { walletAmountLabel, walletDeltaLabel, walletTween } from "./wallet-animation";
import styles from "./world-wallet.module.css";

function Currency({ kind, amount }: { kind: "coins" | "pearls"; amount: number }) {
  const label = kind === "coins" ? "Монеты" : "Жемчуг";
  const number = useRef<HTMLSpanElement>(null);
  const effect = useRef<HTMLSpanElement>(null);
  const deltaText = useRef<HTMLSpanElement>(null);
  const displayed = useRef(amount);
  const confirmed = useRef(amount);

  useLayoutEffect(() => {
    const count = number.current, feedback = effect.current, deltaNode = deltaText.current;
    if (!count || !feedback || !deltaNode) return;
    const delta = amount - confirmed.current;
    confirmed.current = amount;
    // Mount/reopening, polling and retries with an unchanged balance have no reward effect.
    if (!delta) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const from = displayed.current;
    let frame = 0;
    let finished = false;
    const settle = () => {
      finished = true;
      cancelAnimationFrame(frame);
      displayed.current = amount;
      count.textContent = walletAmountLabel(amount, kind);
      feedback.hidden = true;
      feedback.getAnimations().forEach(animation => animation.cancel());
    };
    const onVisibility = () => { if (document.hidden) settle(); };
    const onMotion = () => { if (motion.matches) settle(); };
    if (motion.matches || document.hidden) {
      settle();
      return;
    }
    count.textContent = walletAmountLabel(from, kind);
    deltaNode.textContent = walletDeltaLabel(delta, kind);
    feedback.dataset.direction = delta > 0 ? "gain" : "spend";
    feedback.hidden = false;
    const animation = feedback.animate([
      { opacity: 0, transform: "translateY(8px) scale(.92)" },
      { opacity: 1, transform: "translateY(0) scale(1)", offset: .18 },
      { opacity: 1, transform: "translateY(-2px) scale(1)", offset: .65 },
      { opacity: 0, transform: "translateY(-14px) scale(.96)" },
    ], { duration: 1300, easing: "ease-out" });
    animation.onfinish = () => { feedback.hidden = true; };
    const start = performance.now();
    const tick = (time: number) => {
      if (finished) return;
      const progress = Math.min(1, (time - start) / 650);
      displayed.current = walletTween(from, amount, progress);
      count.textContent = walletAmountLabel(displayed.current, kind);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    motion.addEventListener("change", onMotion);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      finished = true;
      cancelAnimationFrame(frame);
      animation.cancel();
      feedback.hidden = true;
      motion.removeEventListener("change", onMotion);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [amount, kind]);

  return <div className={styles.currency} data-currency={kind} data-balance={amount}>
    <dt><ItemIcon itemId={kind} size={18} /><span className={styles.sr}>{label}</span></dt>
    <dd>
      <span ref={number} aria-hidden="true">{walletAmountLabel(amount, kind)}</span>
      <span className={styles.sr} aria-live="polite" aria-atomic="true">{label}: {walletAmountLabel(amount, kind)}</span>
      <span ref={effect} className={styles.change} hidden aria-hidden="true" data-wallet-change>
        <ItemIcon itemId={kind} size={18} /><span ref={deltaText} />
      </span>
    </dd>
  </div>;
}

export function WorldWallet({ coins, pearls }: { coins: number; pearls: number }) {
  return <dl className={styles.wallet} aria-label="Ваши валюты">
    <Currency kind="coins" amount={coins} />
    <Currency kind="pearls" amount={pearls} />
  </dl>;
}

"use client";

import { Sparkles, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { EconomyView } from "@/features/economy/domain/model";
import { tapBoostView } from "@/features/economy/domain/tap-boost";
import styles from "./tap-boost-indicator.module.css";

/** One small control beside the calendar; the orbit carries the always-visible clock. */
export function TapBoostIndicator({ snapshot, now }: { snapshot: EconomyView | null; now: number }) {
  const panel = useRef<HTMLDetailsElement>(null);
  function close(returnFocus = false) {
    if (!panel.current?.open) return;
    panel.current.open = false;
    if (returnFocus) panel.current.querySelector("summary")?.focus({ preventScroll: true });
  }
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const details = panel.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) details.open = false;
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, []);
  useEffect(() => { if (panel.current) panel.current.open = false; }, [snapshot?.ownerPublicId]);
  if (!snapshot) return null;
  const boost = tapBoostView(snapshot, now);
  const available = snapshot.jobs.some(job => (job.kind === "production" || job.kind === "exploration" && job.actorId === "miner")
    && Date.parse(job.finishesAt) > now);
  const percent = boost.powerPercent.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  return <details ref={panel} className={styles.panel} data-active={boost.active || undefined}
    onKeyDown={event => { if (event.key === "Escape" && panel.current?.open) { event.preventDefault(); event.stopPropagation(); close(true); } }}
    onBlur={event => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close(); }}>
    <summary className={styles.summary} aria-label={`Помощь тапами: +${percent}% к скорости. Открыть пояснение`}>
      <Sparkles className={styles.emblem} size={16} aria-hidden="true" />
      <strong className={styles.power}>+{percent}%</strong>
    </summary>
    <div className={styles.description} tabIndex={0} role="region" aria-label="Как работает помощь тапами">
      <div className={styles.descriptionHeading}><strong>Помощь тапами</strong><button type="button" aria-label="Закрыть помощь тапами" onClick={() => close(true)}><X size={16} aria-hidden="true" /></button></div>
      <div className={styles.target}>
        <span>{boost.active ? <>Помощь: <strong>{boost.targetName}</strong></>
          : available ? "Нажимай «Я живой» и ускоряй работу" : "Запусти производство или добычу"}</span>
        {boost.active && <strong className={styles.remaining} aria-label={`Время помощи: ${boost.remainingSeconds} с`}>{boost.remainingSeconds} с</strong>}
      </div>
      <div className={styles.rules}>
        <div className={styles.timeRule}><strong>+1 с</strong><span>за каждый тап</span></div>
        <div className={styles.powerRule}><strong>до +20%</strong><span>к скорости работы</span></div>
      </div>
      <p className={styles.footnote}>Запас до <strong>60 с</strong>. Ускоряется одна работа.</p>
    </div>
  </details>;
}

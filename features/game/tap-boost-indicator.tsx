"use client";

import { ChevronDown, Sparkles, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { EconomyView } from "@/features/economy/domain/model";
import { tapBoostView } from "@/features/economy/domain/tap-boost";
import styles from "./tap-boost-indicator.module.css";

/** Compact target companion to the button's time/power orbit. Details are opt-in. */
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
    <summary className={styles.summary}>
      <span className={styles.emblem}><Sparkles size={16} aria-hidden="true" /></span>
      <span className={styles.label}>{boost.active ? boost.targetName : "Помощь тапами"}
        {!boost.active && <small>{available ? "Тапай, чтобы помочь текущей работе" : "Запусти производство или добычу"}</small>}
      </span>
      {boost.active && <strong className={styles.power}>+{percent}%<small>скорости</small></strong>}
      <ChevronDown className={styles.chevron} size={14} aria-hidden="true" />
    </summary>
    <div className={styles.description} tabIndex={0} role="region" aria-label="Как работает помощь тапами">
      <div className={styles.descriptionHeading}><strong>Помощь производству</strong><button type="button" aria-label="Закрыть помощь тапами" onClick={() => close(true)}><X size={16} aria-hidden="true" /></button></div>
      {boost.active && <dl className={styles.stats}>
        <div><dt>Время помощи</dt><dd>{boost.remainingSeconds} с</dd></div>
        <div><dt>Заряд</dt><dd>{boost.charge} / 1000</dd></div>
      </dl>}
      <p>Светящаяся дуга вокруг кнопки показывает оставшееся время, а яркость — мощность. Каждый подтверждённый тап добавляет секунду действия; в запасе не больше минуты.</p>
      <p>Мощность: 1 тап — 1%, 100 — 9%, 500 — 17%, 1000 — 20%. Пока помощь действует, сила сохраняется. Когда огонёк погаснет, новый заряд начинается с начала.</p>
      <p>Помощь получает одна работа с ближайшим результатом. Стройка и путешествия не ускоряются. Минута помощи при +20% даёт 12 секунд дополнительной работы.</p>
    </div>
  </details>;
}

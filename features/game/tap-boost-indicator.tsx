"use client";

import { Sparkles } from "lucide-react";
import type { CSSProperties } from "react";
import type { EconomyView } from "@/features/economy/domain/model";
import { tapBoostView } from "@/features/economy/domain/tap-boost";
import styles from "./tap-boost-indicator.module.css";

export function TapBoostIndicator({ snapshot, now }: { snapshot: EconomyView | null; now: number }) {
  if (!snapshot) return null;
  const boost = tapBoostView(snapshot, now);
  const available = snapshot.jobs.some(job => (job.kind === "production" || job.kind === "exploration" && job.actorId === "miner")
    && Date.parse(job.finishesAt) > now);
  const percent = boost.powerPercent.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  return <details className={styles.panel} data-active={boost.active || undefined}>
    <summary className={styles.summary}>
      <Sparkles size={17} aria-hidden="true" />
      <span className={styles.label}>{boost.active ? `${boost.targetName} · +${percent}% скорости` : "Помощь тапами"}
        <small>{boost.active ? `Заряд ${boost.charge} / 1000 · осталось ${boost.remainingSeconds} с`
          : available ? "Тапай, чтобы ускорять текущую работу" : "Сначала запусти производство или добычу"}</small>
      </span>
      <span className={styles.limit}>{boost.active ? `${boost.remainingSeconds} с` : "до +20%"}</span>
    </summary>
    <div className={styles.description}>
      <p>Каждый подтверждённый тап добавляет секунду действия, максимум — минуту. Мощность растёт с зарядом: 1 тап — 1%, 100 — 9%, 500 — 17%, 1000 — 20%.</p>
      <p>Ускоряется одно место с ближайшим результатом. Продолжай тапать, чтобы поддерживать заряд. После паузы и окончания заряда мощность начинается заново. Стройка и путешествия не ускоряются.</p>
    </div>
    <div className={styles.track} role="progressbar" aria-label="Мощность помощи тапами" aria-valuemin={0} aria-valuemax={20}
      aria-valuenow={boost.powerPercent} aria-valuetext={boost.active ? `Скорость выше на ${percent} процентов` : "Помощь не активна"}
      style={{ "--boost-fill": `${boost.powerPercent / 20 * 100}%` } as CSSProperties}>
      <span />
    </div>
  </details>;
}

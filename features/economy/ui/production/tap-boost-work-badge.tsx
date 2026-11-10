import { Sparkles } from "lucide-react";
import type { EconomyView } from "@/features/economy/domain/model";
import { tapBoostView } from "@/features/economy/domain/tap-boost";
import styles from "./tap-boost-work-badge.module.css";

/** A pending local job must never inherit the confirmed job's help. */
export function jobTapBoostPercent(state: EconomyView, jobId: string, now: number): number {
  if (state.tapBoost?.jobId !== jobId) return 0;
  const job = state.jobs.find(entry => entry.id === jobId);
  if (!job || !(job.kind === "production" || job.kind === "exploration" && job.actorId === "miner")) return 0;
  const boost = tapBoostView(state, now);
  return boost.active ? Math.max(0, boost.powerPercent) : 0;
}

export function TapBoostWorkBadge({ percent, compact = false }: { percent: number; compact?: boolean }) {
  if (percent <= 0) return null;
  const value = percent.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  return <span className={styles.badge} data-compact={compact || undefined} aria-label={`Помощь тапами: скорость выше на ${value}%`} title="Этой работе помогает заряд от тапов">
    <Sparkles size={compact ? 10 : 12} aria-hidden="true" />
    <span>{compact ? `+${value}%` : `Помощь тапами · +${value}%`}</span>
  </span>;
}

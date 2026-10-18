import { Clock3, RefreshCw } from "lucide-react";
import { marketRefreshCountdown } from "./market-refresh-time";
import styles from "./market-refresh-progress.module.css";

/** The session clock is anchored to server time; this display never starts its own clock or changes stock. */
export function MarketRefreshProgress({ refreshAt, refreshSeconds, now, label = "Новая витрина", pendingLabel = "Пора обновить витрину" }: {
  refreshAt: string | number; refreshSeconds: number; now: number; label?: string; pendingLabel?: string;
}) {
  const countdown = marketRefreshCountdown(refreshAt, refreshSeconds, now);
  const Icon = countdown?.expired ? RefreshCw : Clock3;
  return <div className={styles.refresh} data-market-refresh={countdown?.expired ? "ready" : countdown ? "waiting" : "unknown"}>
    <div className={styles.heading}><span><Icon size={15} aria-hidden="true" />{countdown?.expired ? pendingLabel : label}</span>
      <strong role="timer" aria-label={countdown?.expired ? pendingLabel : countdown ? `${label} через ${countdown.spoken}` : "Уточняем время обновления"}>{countdown?.label ?? "—"}</strong>
    </div>
    <progress className={styles.progress} max={1} value={countdown?.remainingFraction ?? 0} aria-label={countdown ? `Осталось времени: ${countdown.spoken}` : "Время обновления уточняется"} />
  </div>;
}

import { RefreshCw } from "lucide-react";
import { dataFreshnessMessage } from "@/lib/data-freshness";
import styles from "./data-freshness.module.css";

export function DataFreshness({ updatedAt, nowMs, isOnline, failed, loading, onRefresh }: {
  updatedAt: number | null;
  nowMs: number;
  isOnline: boolean;
  failed: boolean;
  loading: boolean;
  onRefresh: () => Promise<void>;
}) {
  const stale = failed || !isOnline || (updatedAt !== null && nowMs - updatedAt >= 120_000);
  return <div className={styles.bar} data-stale={stale}>
    <span role="status">{dataFreshnessMessage({ updatedAt, nowMs, isOnline, failed, loading })}</span>
    <button type="button" disabled={loading || !isOnline} onClick={() => void onRefresh()} aria-label="Обновить список">
      <RefreshCw size={16} aria-hidden="true" />
      <span>Обновить</span>
    </button>
  </div>;
}

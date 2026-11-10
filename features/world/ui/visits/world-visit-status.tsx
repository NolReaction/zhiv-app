"use client";

import { ArrowLeft, LoaderCircle, RefreshCw, WifiOff } from "lucide-react";
import styles from "./world-visit-shell.module.css";

export function WorldVisitStatus({ text, loading = false, offline = false, onReturn, onRetry }: {
  text: string; loading?: boolean; offline?: boolean; onReturn: () => void; onRetry?: () => void;
}) {
  return <div className={styles.status} data-guest-world-status>
    <div className={styles.card}>
      {loading ? <LoaderCircle className={styles.spinner} size={30} aria-hidden="true" /> : offline ? <WifiOff size={30} aria-hidden="true" /> : null}
      <p role="status">{text}</p>
      <div className={styles.actions}>
        <button type="button" data-guest-return onClick={onReturn}><ArrowLeft size={17} aria-hidden="true" />В свой лес</button>
        {onRetry && <button type="button" onClick={onRetry}><RefreshCw size={17} aria-hidden="true" />Попробовать ещё раз</button>}
      </div>
    </div>
  </div>;
}

"use client";
import { useEffect, useState, type CSSProperties } from "react";
import { CloudOff, RefreshCw } from "lucide-react";
import type { WorldController } from "./use-world";
import styles from "./world.module.css";

function TimedFeedback({ world }: { world: WorldController }) {
  const [remaining] = useState(() => Math.max(0, 5500 - (Date.now() - world.feedbackAt)));
  const [expired, setExpired] = useState(remaining === 0);
  useEffect(() => { const timer = setTimeout(() => setExpired(true), remaining); return () => clearTimeout(timer); }, [remaining]);
  if (expired && !world.error) return null;
  return <div className={styles.feedback} data-collapsed={expired} role="status" aria-live="polite">
    {expired ? <button onClick={() => void world.retry()} disabled={world.busy} aria-label={`${world.error}. ${world.uncertain ? "Проверить результат" : "Обновить"}`} title={world.error ?? "Обновить"}><CloudOff size={19} /></button>
      : <div className={styles.notice} style={{ "--notice-delay": `${remaining - 5500}ms` } as CSSProperties}>
        <span>{world.error ?? world.notice}</span>
        {world.error && <button disabled={world.busy} onClick={() => void world.retry()} aria-label={world.uncertain ? "Проверить результат" : "Обновить"}><RefreshCw size={17} /></button>}
        <i aria-hidden />
      </div>}
  </div>;
}
export function WorldFeedback({ world }: { world: WorldController }) {
  if (world.busy || !world.error && !world.notice) return null;
  return <TimedFeedback key={`${world.feedbackAt}:${world.error ?? world.notice}`} world={world} />;
}

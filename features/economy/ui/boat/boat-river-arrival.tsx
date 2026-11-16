"use client";

import { useLayoutEffect } from "react";
import styles from "./boat-river-arrival.module.css";

type Props = { voyageId: string; suspended: boolean; onFinish: (id: string) => void };

export function BoatRiverArrival({ voyageId, suspended, onFinish }: Props) {
  useLayoutEffect(() => {
    const finish = () => onFinish(voyageId);
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const skipIfHidden = () => { if (document.hidden || motion?.matches) finish(); };
    if (suspended || document.hidden || motion?.matches) { finish(); return; }
    // Animation events can be dropped on backgrounding or a compositor restart.
    const timeout = window.setTimeout(finish, 1100);
    document.addEventListener("visibilitychange", skipIfHidden);
    motion?.addEventListener?.("change", skipIfHidden);
    return () => {
      window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", skipIfHidden);
      motion?.removeEventListener?.("change", skipIfHidden);
    };
  }, [voyageId, suspended, onFinish]);

  return <div aria-hidden="true" className={styles.departure} data-boat-arrival>
    <div className={styles.workshop} />
    <div className={styles.pier}><i /><i /></div>
    <div className={styles.shade} onAnimationEnd={event => {
      if (event.target === event.currentTarget) onFinish(voyageId);
    }} />
  </div>;
}

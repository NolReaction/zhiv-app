"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import styles from "./boat-reel-progress.module.css";

const maximum = 10000;
const normalize = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(maximum, value)) : 0;

/** Milestones acknowledge new progress once, including when hidden/paused updates consume it. */
export function createBoatProgressMilestones(initialValue: number) {
  let highest = Math.floor(normalize(initialValue) / 2500);
  return {
    update(value: number, playing: boolean): number | null {
      const quarter = Math.floor(normalize(value) / 2500);
      const reached = quarter > highest;
      highest = Math.max(highest, quarter);
      return reached && playing ? quarter : null;
    },
  };
}

/** The gradient occupies the whole distance; clipping never stretches its gold end into a short fill. */
export function BoatReelProgress({ value, danger = false, playing = false }: { value: number; danger?: boolean; playing?: boolean }) {
  const progress = normalize(value);
  const tracker = useRef(createBoatProgressMilestones(progress));
  const track = useRef<HTMLSpanElement>(null), marks = useRef<Array<HTMLSpanElement | null>>([]);
  const motion = useRef<MediaQueryList | undefined>(undefined), accent = useRef<Animation | null>(null);
  useEffect(() => {
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    motion.current = preference;
    const stop = () => { if (preference?.matches) { accent.current?.cancel(); accent.current = null; } };
    preference?.addEventListener?.("change", stop);
    return () => { preference?.removeEventListener?.("change", stop); accent.current?.cancel(); accent.current = null; };
  }, []);
  useEffect(() => {
    if (!playing) { accent.current?.cancel(); accent.current = null; }
    const quarter = tracker.current.update(progress, playing);
    if (quarter === null || motion.current?.matches || danger || document.hidden) return;
    const node = quarter === 4 ? track.current : marks.current[quarter - 1];
    if (!node?.animate) return;
    accent.current?.cancel();
    accent.current = node.animate([
      { boxShadow: "0 0 0 0 rgba(239,217,155,0)" },
      { boxShadow: "0 0 7px 2px rgba(239,217,155,.65)", offset: .35 },
      { boxShadow: "0 0 0 0 rgba(239,217,155,0)" },
    ], { duration: 420, easing: "ease-out" });
  }, [progress, playing, danger]);
  return <span ref={track} className={styles.track} data-reel-progress-track data-danger={danger || undefined}
    style={{ "--reel-progress": `${progress / 100}%` } as CSSProperties}>
    <progress className={styles.native} value={progress} max={maximum} aria-label="Рыба на крючке" />
    <span className={styles.fill} aria-hidden="true" />
    {[25, 50, 75].map((mark, index) => <span key={mark} ref={node => { marks.current[index] = node; }}
      className={styles.milestone} data-reached={progress >= mark * 100 || undefined} data-progress-mark={mark}
      title={`${mark}%`} aria-hidden="true" style={{ left: `${mark}%` }} />)}
  </span>;
}

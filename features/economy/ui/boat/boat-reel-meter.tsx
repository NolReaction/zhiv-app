import type { CSSProperties } from "react";
import styles from "./boat-reel-meter.module.css";

export type BoatReelMeterState = { bar: number; fish: number; zoneWidth: number };
const bounded = (value: number, fallback = 5000) => Math.max(0, Math.min(10000, Number.isFinite(value) ? value : fallback));

/** Exact domain coordinates, expressed top-down. Clipping never shifts the catchable interval. */
export function boatReelMeterGeometry({ bar, fish, zoneWidth }: BoatReelMeterState) {
  const center = bounded(bar), target = bounded(fish), half = bounded(zoneWidth, 3200) / 2;
  const low = Math.max(0, center - half), high = Math.min(10000, center + half);
  return { bar: center, fish: target, top: (10000 - high) / 100, height: (high - low) / 100,
    targetTop: (10000 - target) / 100, inZone: Math.abs(target - center) <= half };
}

/** The anonymous tug marker represents a hooked fish; identity belongs to the confirmed catch card. */
export function BoatReelMeter({ reel, held, paused = false, danger = false }: {
  reel: BoatReelMeterState; held: boolean; paused?: boolean; danger?: boolean;
}) {
  const geometry = boatReelMeterGeometry(reel);
  const label = `Зона снасти: ${Math.round(geometry.bar / 100)}%. Рыба: ${Math.round(geometry.fish / 100)}%. ${geometry.inZone ? "Рыба в зоне" : "Рыба вне зоны"}.`;
  return <div className={styles.meter} data-boat-reel-meter data-in-zone={geometry.inZone}
    data-held={held || undefined} data-paused={paused || undefined} data-danger={danger || undefined} role="img" aria-label={label}>
    <span className={styles.railLabel} aria-hidden="true">СНАСТЬ</span>
    <div className={styles.track}>
      <span className={styles.ticks} aria-hidden="true" />
      <span className={styles.zone} data-reel-zone style={{ top: `${geometry.top}%`, height: `${geometry.height}%` } as CSSProperties} aria-hidden="true"><i /><i /><i /></span>
      <span className={styles.target} data-reel-target style={{ top: `${geometry.targetTop}%` }} aria-hidden="true"><i /><span>?</span><i /></span>
    </div>
  </div>;
}

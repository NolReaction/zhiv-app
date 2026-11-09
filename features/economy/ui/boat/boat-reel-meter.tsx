import type { CSSProperties } from "react";
import styles from "./boat-reel-meter.module.css";

export type BoatReelMeterState = { bar: number; fish: number; zoneWidth: number };
const bounded = (value: number, fallback = 5000) => Math.max(0, Math.min(10000, Number.isFinite(value) ? value : fallback));

/** Exact domain coordinates, expressed top-down. Clipping never shifts the catchable interval. */
export function boatReelMeterGeometry({ bar, fish, zoneWidth }: BoatReelMeterState) {
  const center = bounded(bar), target = bounded(fish), width = bounded(zoneWidth, 3200);
  return { bar: center, fish: target, centerTop: (10000 - center) / 100, height: width / 100,
    targetTop: (10000 - target) / 100, inZone: Math.abs(target - center) <= width / 2 };
}

/** The anonymous tug marker represents a hooked fish; identity belongs to the confirmed catch card. */
export function BoatReelMeter({ reel, held, paused = false, danger = false, tickMs = 50 }: {
  reel: BoatReelMeterState; held: boolean; paused?: boolean; danger?: boolean; tickMs?: number;
}) {
  const geometry = boatReelMeterGeometry(reel);
  const label = `Зона снасти: ${Math.round(geometry.bar / 100)}%. Рыба: ${Math.round(geometry.fish / 100)}%. ${geometry.inZone ? "Рыба в зоне" : "Рыба вне зоны"}.`;
  return <div className={styles.meter} style={{ "--step-time": `${tickMs}ms` } as CSSProperties} data-boat-reel-meter data-in-zone={geometry.inZone}
    data-held={held || undefined} data-paused={paused || undefined} data-danger={danger || undefined} role="img" aria-label={label}>
    <span className={styles.railLabel} aria-hidden="true">СНАСТЬ</span>
    <div className={styles.track}>
      <span className={styles.ticks} aria-hidden="true" />
      <span className={styles.zoneClip} aria-hidden="true"><span className={styles.carriage} data-reel-zone style={{ transform: `translateY(${geometry.centerTop}%)` }}>
        <span className={styles.zone} style={{ height: `${geometry.height}%` }}><i /><i /><i /></span>
      </span></span>
      <span className={styles.carriage} data-reel-target style={{ transform: `translateY(${geometry.targetTop}%)` }} aria-hidden="true">
        <span className={styles.target}><i /><span>?</span><i /></span>
      </span>
    </div>
  </div>;
}

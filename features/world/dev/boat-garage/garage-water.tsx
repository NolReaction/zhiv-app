"use client";

import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from "react";
import { advanceGarageWaterMotion, garageWaterRigTransform, initialGarageWaterMotion } from "./garage-water-motion.mjs";
import type { GaragePoint } from "./garage-scene-types";
import styles from "./garage-water.module.css";

const MOTION_QUERY = "(prefers-reduced-motion: reduce)";
function subscribeWaterActivity(listener: () => void) {
  const media = window.matchMedia(MOTION_QUERY);
  media.addEventListener("change", listener);
  document.addEventListener("visibilitychange", listener);
  return () => { media.removeEventListener("change", listener); document.removeEventListener("visibilitychange", listener); };
}
function waterActivity() { return !document.hidden && !window.matchMedia(MOTION_QUERY).matches; }
function serverWaterActivity() { return false; }
function useWaterAnimation(running: boolean) {
  return useSyncExternalStore(subscribeWaterActivity, waterActivity, serverWaterActivity) && running;
}

/** World-coordinate background; it replaces only the studio backdrop. */
export function GarageWaterBackground({ width, height, running = true }: { width: number; height: number; running?: boolean }) {
  const id = useId().replace(/:/g, ""), active = useWaterAnimation(running);
  return <g className={styles.water} data-active={active} data-testid="garage-water-background" aria-hidden="true">
    <defs>
      <pattern id={`${id}-texture`} width="256" height="192" patternUnits="userSpaceOnUse">
        <image href="/world/boat/river-water.webp" width="256" height="192" />
      </pattern>
      <linearGradient id={`${id}-depth`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#163e53" stopOpacity=".36" /><stop offset=".5" stopColor="#0b8d98" stopOpacity=".05" /><stop offset="1" stopColor="#062e41" stopOpacity=".32" />
      </linearGradient>
      <clipPath id={`${id}-clip`}><rect width={width} height={height} /></clipPath>
    </defs>
    <rect width={width} height={height} fill="#0b627b" />
    <g clipPath={`url(#${id}-clip)`}>
      <g className={styles.flow}><rect x={-256} y={-192} width={width + 512} height={height + 384} fill={`url(#${id}-texture)`} /></g>
    </g>
    <rect width={width} height={height} fill={`url(#${id}-depth)`} />
  </g>;
}

/** One transform moves every modular part, including its editor overlay.
 * Pausing restores the exact editable pose and never writes scene/history. */
export function GarageWaterRig({ center, beam, amplitude = 10, running = true, children }: {
  center: GaragePoint; beam: number; amplitude?: number; running?: boolean; children: ReactNode;
}) {
  const group = useRef<SVGGElement>(null);
  const active = useWaterAnimation(running), centerX = center.x, centerY = center.y;
  useEffect(() => {
    const element = group.current;
    if (!element) return;
    let frame = 0, previousTime: number | null = null, motion = initialGarageWaterMotion();
    const reset = () => { element.removeAttribute("transform"); element.dataset.heave = "0"; element.dataset.roll = "0"; };
    if (!active) { reset(); return; }
    const tick = (time: number) => {
      if (!waterActivity()) { frame = 0; return; }
      const elapsed = previousTime === null ? 0 : Math.min(.1, (time - previousTime) / 1000);
      previousTime = time;
      motion = advanceGarageWaterMotion(motion, elapsed, { beam, centerX, amplitude });
      element.setAttribute("transform", garageWaterRigTransform(motion, { x: centerX, y: centerY }));
      element.dataset.heave = motion.heave.toFixed(4); element.dataset.roll = motion.roll.toFixed(4);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); reset(); };
  }, [active, amplitude, beam, centerX, centerY]);
  return <g ref={group} data-testid="garage-water-rig" data-running={active}>{children}</g>;
}

/** Static contact shadow and slowly moving foam hide the cutout's floating edge. */
export function GarageWaterContact({ center, beam, running = true, layer = "all", enabled = false, opacity = .65, offsetY = 0 }: {
  center: GaragePoint; beam: number; running?: boolean; layer?: "all" | "shadow" | "surface";
  enabled?: boolean; opacity?: number; offsetY?: number;
}) {
  const active = useWaterAnimation(running), half = Math.max(50, beam * .44), depth = Math.max(12, Math.min(36, beam * .034));
  if (!enabled || opacity <= 0) return null;
  return <g className={styles.water} data-active={active} transform={`translate(${center.x} ${center.y + offsetY})`}
    opacity={opacity} data-testid={`garage-water-contact-${layer}`} aria-hidden="true">
    {layer !== "surface" && <ellipse className={styles.shadow} cx="0" cy="7" rx={half} ry={depth} />}
    {layer !== "shadow" && <>
    <ellipse className={styles.ripple} cx="0" cy="7" rx={half * 1.02} ry={depth * 1.15} />
    <ellipse className={`${styles.ripple} ${styles.rippleLate}`} cx="0" cy="7" rx={half * 1.02} ry={depth * 1.15} />
    <path className={styles.foam} d={`M${-half} 2 C${-half * .66} ${depth},${half * .45} ${depth * 1.12},${half} 0`} />
    <path className={styles.foam} d={`M${-half * .92} -4 C${-half * .5} ${-depth * .75},${half * .45} ${-depth * .65},${half * .96} -4`} opacity=".4" />
    </>}
  </g>;
}

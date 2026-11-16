"use client";

import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from "react";
import { advanceGarageWaterMotion, garageWaterRigTransform, initialGarageWaterMotion } from "./garage-water-motion.mjs";
import type { GaragePoint } from "./garage-scene-types";
import styles from "./garage-water.module.css";

const MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const waterGlints = Array.from({ length: 19 }, (_, index) => {
  const seed = (n: number) => { const value = Math.sin(n * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value); };
  return { x: .06 + seed(index * 19 + 8) * .88, y: .06 + seed(index * 31 + 16) * .88,
    width: 6 + seed(index * 13 + 41) * 15, delay: -seed(index * 17 + 53) * 13 };
});
function subscribeWaterActivity(listener: () => void) {
  const media = window.matchMedia(MOTION_QUERY);
  media.addEventListener("change", listener);
  document.addEventListener("visibilitychange", listener);
  return () => { media.removeEventListener("change", listener); document.removeEventListener("visibilitychange", listener); };
}
function waterActivity() { return !document.hidden && !window.matchMedia(MOTION_QUERY).matches; }
function serverWaterActivity() { return false; }
export function useGarageWaterAnimation(running: boolean) {
  return useSyncExternalStore(subscribeWaterActivity, waterActivity, serverWaterActivity) && running;
}

/** World-coordinate background; it replaces only the studio backdrop. */
export function GarageWaterBackground({ width, height, running = true }: { width: number; height: number; running?: boolean }) {
  const id = useId().replace(/:/g, ""), active = useGarageWaterAnimation(running);
  return <g className={styles.water} data-active={active} data-testid="garage-water-background" aria-hidden="true">
    <defs>
      <linearGradient id={`${id}-depth`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#163e53" stopOpacity=".36" /><stop offset=".5" stopColor="#0b8d98" stopOpacity=".05" /><stop offset="1" stopColor="#062e41" stopOpacity=".32" />
      </linearGradient>
      <clipPath id={`${id}-clip`}><rect width={width} height={height} /></clipPath>
    </defs>
    <rect width={width} height={height} fill="#0b627b" />
    <g clipPath={`url(#${id}-clip)`}>
      <g className={styles.flow}>
        <image href="/world/boat/lake-water.webp?v=1" x={-width * .08} y={-height * .08}
          width={width * 1.16} height={height * 1.16} preserveAspectRatio="xMidYMid slice" />
      </g>
      {waterGlints.map((glint, index) => <path key={index} className={styles.glint}
        d={`M${width * glint.x} ${height * glint.y} q${glint.width * .5} -1 ${glint.width} 0`}
        style={{ animationDelay: `${glint.delay}s` }} />)}
    </g>
    <rect width={width} height={height} fill={`url(#${id}-depth)`} />
  </g>;
}

/** One transform moves every modular part, including its editor overlay.
 * Pausing restores the exact editable pose and never writes scene/history. */
export function GarageWaterRig({ center, beam, amplitude = 10, running = true, children, id, onFrame }: {
  center: GaragePoint; beam: number; amplitude?: number; running?: boolean; children: ReactNode; id?: string;
  onFrame?: (motion: ReturnType<typeof initialGarageWaterMotion>, seconds: number) => void;
}) {
  const group = useRef<SVGGElement>(null);
  const active = useGarageWaterAnimation(running), centerX = center.x, centerY = center.y;
  useEffect(() => {
    const element = group.current;
    if (!element) return;
    let frame = 0, previousTime: number | null = null, motion = initialGarageWaterMotion();
    const reset = () => { element.removeAttribute("transform"); element.dataset.heave = "0"; element.dataset.roll = "0"; onFrame?.(initialGarageWaterMotion(), 0); };
    if (!active) { reset(); return; }
    const tick = (time: number) => {
      if (!waterActivity()) { frame = 0; return; }
      const elapsed = previousTime === null ? 0 : Math.min(.1, (time - previousTime) / 1000);
      previousTime = time;
      motion = advanceGarageWaterMotion(motion, elapsed, { beam, centerX, amplitude });
      element.setAttribute("transform", garageWaterRigTransform(motion, { x: centerX, y: centerY }));
      element.dataset.heave = motion.heave.toFixed(4); element.dataset.roll = motion.roll.toFixed(4);
      onFrame?.(motion, motion.tick / 120);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); reset(); };
  }, [active, amplitude, beam, centerX, centerY, onFrame]);
  return <g id={id} ref={group} data-testid="garage-water-rig" data-running={active}>{children}</g>;
}

"use client";

import { useCallback, useId, useRef, type ReactNode } from "react";
import { GarageWaterRig, useGarageWaterAnimation } from "./garage-water";
import { garageWaterContactFrame } from "./garage-water-contact.mjs";
import { initialGarageWaterMotion } from "./garage-water-motion.mjs";
import type { GaragePoint } from "./garage-scene-types";
import styles from "./garage-water.module.css";

type Motion = ReturnType<typeof initialGarageWaterMotion>;
type Props = { center: GaragePoint; beam: number; amplitude: number; running: boolean; width: number; height: number;
  effectsEnabled: boolean; immersionEnabled: boolean; effectOpacity: number; effectOffsetY: number; children: ReactNode };

/** Alpha-clipped water crosses the moving hull; reflection reuses that exact transform.
 * Nothing is rasterised, persisted, attached to the boat rig or animated while hidden. */
export function GarageWaterPresentation({ center, beam, amplitude, running, width, height, effectsEnabled,
  immersionEnabled, effectOpacity, effectOffsetY, children }: Props) {
  const id = `garage-water-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`, active = useGarageWaterAnimation(running);
  const surfacePaths = useRef<(SVGPathElement | null)[]>([]), submergedPaths = useRef<(SVGPathElement | null)[]>([]);
  const wavePaths = useRef<(SVGPathElement | null)[]>([]), reflectionGroup = useRef<SVGGElement>(null);
  const centerX = center.x, centerY = center.y;
  const initial = garageWaterContactFrame(center, beam, 0, amplitude, height + 200, width);
  const update = useCallback((motion: Motion, seconds: number) => {
    const frame = garageWaterContactFrame({ x: centerX, y: centerY }, beam, seconds, amplitude, height + 200, width);
    surfacePaths.current.forEach(path => path?.setAttribute("d", frame.surface));
    submergedPaths.current.forEach(path => path?.setAttribute("d", frame.submerged));
    const energy = Math.min(1, Math.abs(motion.velocity) / 12 + Math.abs(motion.angularVelocity) / 5);
    wavePaths.current.forEach((path, index) => {
      path?.setAttribute("d", frame.wavelets[index].d);
      path?.setAttribute("opacity", String(frame.wavelets[index].opacity * (.8 + energy * .6)));
    });
    reflectionGroup.current?.setAttribute("transform", `translate(${frame.reflections[0].x} 0)`);
  }, [amplitude, beam, centerX, centerY, height, width]);
  const decorative = effectsEnabled && effectOpacity > 0;
  const mirror = `translate(0 ${centerY * 1.34}) scale(1 -.34)`;
  return <g className={styles.waterPresentation} data-active={active} data-testid="garage-water-presentation">
    <defs>
      <clipPath id={`${id}-canvas`} clipPathUnits="userSpaceOnUse"><rect x="0" y="0" width={width} height={height} /></clipPath>
      <mask id={`${id}-alpha`} maskUnits="userSpaceOnUse" x="0" y="0" width={width} height={height} style={{ maskType: "alpha" }}>
        <use href={`#${id}-rig`} />
      </mask>
      <clipPath id={`${id}-below`}><path ref={element => { submergedPaths.current[0] = element; }} d={initial.submerged} /></clipPath>
      <linearGradient id={`${id}-wet-depth`} gradientUnits="userSpaceOnUse" x1="0" y1={centerY - 2} x2="0" y2={centerY + 46}>
        <stop offset="0" stopColor="#266f73" stopOpacity=".3" /><stop offset="1" stopColor="#0a4a57" stopOpacity=".72" />
      </linearGradient>
      <linearGradient id={`${id}-reflection-depth`} gradientUnits="userSpaceOnUse" x1="0" y1={centerY} x2="0" y2={centerY + 64}>
        <stop offset="0" stopColor="white" /><stop offset="1" stopColor="black" />
      </linearGradient>
      <mask id={`${id}-reflection-fade`} maskUnits="userSpaceOnUse" x="0" y="0" width={width} height={height} style={{ maskType: "luminance" }}>
        <rect width={width} height={height} fill={`url(#${id}-reflection-depth)`} />
      </mask>
      <clipPath id={`${id}-reflection-strips`}>{initial.reflections.map((strip, index) => <rect key={index}
        x={initial.left} y={strip.y} width={initial.right - initial.left} height={strip.height} />)}</clipPath>
    </defs>
    <g clipPath={`url(#${id}-canvas)`}>{decorative && <g className={styles.reflection} aria-hidden="true" transform={`translate(0 ${effectOffsetY})`} opacity={effectOpacity} data-testid="garage-water-reflection">
      <g clipPath={`url(#${id}-reflection-strips)`} mask={`url(#${id}-reflection-fade)`} opacity=".19">
        <g ref={reflectionGroup} transform={`translate(${initial.reflections[0].x} 0)`}>
          <g transform={mirror}><use href={`#${id}-rig`} /></g>
        </g>
      </g>
    </g>}</g>
    <g className={styles.editableRig}>
      <GarageWaterRig id={`${id}-rig`} center={center} beam={beam} amplitude={amplitude} running={running} onFrame={update}>{children}</GarageWaterRig>
    </g>
    <g clipPath={`url(#${id}-canvas)`}>{immersionEnabled && <g className={styles.immersion} mask={`url(#${id}-alpha)`} clipPath={`url(#${id}-below)`} aria-hidden="true" data-testid="garage-water-immersion">
      <path ref={element => { submergedPaths.current[1] = element; }} d={initial.submerged} fill={`url(#${id}-wet-depth)`} />
      <path ref={element => { surfacePaths.current[0] = element; }} d={initial.surface} fill="none" stroke="#092f35" strokeWidth="5" opacity=".58" />
      <path ref={element => { surfacePaths.current[1] = element; }} d={initial.surface} fill="none" stroke="#9bd0c4" strokeWidth="1.3" opacity=".24" strokeDasharray="19 7 4 22" />
    </g>}
    {decorative && <g className={styles.contactWavelets} transform={`translate(0 ${effectOffsetY})`} opacity={effectOpacity} aria-hidden="true" data-testid="garage-water-contact-surface">
      {initial.wavelets.map((wave, index) => <path key={index} ref={element => { wavePaths.current[index] = element; }} d={wave.d} opacity={wave.opacity} />)}
    </g>}
    </g>
  </g>;
}

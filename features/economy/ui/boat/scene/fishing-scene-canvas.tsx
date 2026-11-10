"use client";

import { useEffect, useRef } from "react";
import type { FishingSceneFrame } from "./fishing-scene-types";
import { mountFishingScene } from "./fishing-scene-runtime";

/** A decorative presentation of the existing reel state; input belongs to the game controls. */
export function FishingSceneCanvas({ frame, className }: { frame: FishingSceneFrame; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const initial = useRef(frame);
  const scene = useRef<ReturnType<typeof mountFishingScene> | null>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const mounted = mountFishingScene(canvas.current, initial.current);
    scene.current = mounted;
    return () => { scene.current = null; mounted.dispose(); };
  }, []);
  useEffect(() => { scene.current?.update(frame); }, [frame]);
  return <canvas ref={canvas} className={className} data-fishing-scene={frame.stage} aria-hidden="true"
    style={{ width: "100%", height: "100%", display: "block", pointerEvents: "none" }} />;
}

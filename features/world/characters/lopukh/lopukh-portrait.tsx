"use client";

import { useEffect, useRef } from "react";
import { lopukhSprite } from "./lopukh-sprite";
import { lopukhPortraitPose, startLopukhPortraitAnimation, type LopukhPortraitPose } from "./lopukh-portrait-animation";

/** The dialog provides the accessible name; artwork is shared with the map. */
export function LopukhPortrait({ className, animated = false }: { className?: string; animated?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current, ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    const draw = ({ action, frame, phase, still }: LopukhPortraitPose) => {
      ctx.clearRect(0, 0, 192, 192); ctx.imageSmoothingEnabled = false;
      ctx.drawImage(lopukhSprite(action, "front", frame, phase, still), 0, 0, 192, 192);
    };
    if (animated) return startLopukhPortraitAnimation(draw, element.ownerDocument.defaultView ?? window, element.ownerDocument);
    draw(lopukhPortraitPose(0, true));
  }, [animated]);
  return <canvas ref={canvas} className={className} width={192} height={192} aria-hidden="true" />;
}

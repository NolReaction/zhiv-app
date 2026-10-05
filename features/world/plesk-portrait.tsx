"use client";

import { useEffect, useRef } from "react";
import { pleskSprite } from "./plesk-sprite";
import { pleskPortraitPose, startPleskPortraitAnimation, type PleskPortraitPose } from "./plesk-portrait-animation";

/** Accessible names belong to the card/dialog. The gallery animates the same
 * pixel poses as the resident, on a separate visibility-aware display clock. */
export function PleskPortrait({ className, animated = false }: { className?: string; animated?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current, ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    const draw = ({ action, frame, phase, still }: PleskPortraitPose) => {
      ctx.clearRect(0, 0, 192, 192); ctx.imageSmoothingEnabled = false;
      ctx.drawImage(pleskSprite(action, "front", frame, phase, still), 0, 0, 192, 192);
    };
    if (animated) return startPleskPortraitAnimation(draw, element.ownerDocument.defaultView ?? window, element.ownerDocument);
    draw(pleskPortraitPose(0, true));
  }, [animated]);
  return <canvas ref={canvas} className={className} width={192} height={192} aria-hidden="true" />;
}

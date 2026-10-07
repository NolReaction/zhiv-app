"use client";

import { useEffect, useRef } from "react";
import { builderSprite } from "./builder-sprite";
import { builderPortraitPose, startBuilderPortraitAnimation, type BuilderPortraitPose } from "./builder-portrait-animation";

/** Card/dialog supplies the accessible name; this is the same code-drawn hero
 * as the map, with no independent game clock or construction progress. */
export function BuilderPortrait({ className, animated = false }: { className?: string; animated?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current, ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    const draw = ({ action, frame, phase, still }: BuilderPortraitPose) => {
      ctx.clearRect(0, 0, 192, 192); ctx.imageSmoothingEnabled = false;
      ctx.drawImage(builderSprite(action, "front", frame, phase, still), 0, 0, 192, 192);
    };
    if (animated) return startBuilderPortraitAnimation(draw, element.ownerDocument.defaultView ?? window, element.ownerDocument);
    draw(builderPortraitPose(0, true));
  }, [animated]);
  return <canvas ref={canvas} className={className} width={192} height={192} aria-hidden="true" />;
}

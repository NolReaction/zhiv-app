"use client";

import { useEffect, useRef } from "react";
import { leaftailSprite } from "./leaftail-sprite";
import { leaftailPortraitPose, startLeaftailPortraitAnimation, type LeaftailPortraitPose } from "./leaftail-portrait-animation";

/** The enclosing character card supplies the accessible name. */
export function LeaftailPortrait({ className, animated = false }: { className?: string; animated?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current, ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    const draw = ({ action, frame, phase, still }: LeaftailPortraitPose) => {
      ctx.clearRect(0, 0, 192, 192); ctx.imageSmoothingEnabled = false;
      ctx.drawImage(leaftailSprite(action, "front", frame, phase, still), 0, 0, 192, 192);
    };
    if (animated) return startLeaftailPortraitAnimation(draw, element.ownerDocument.defaultView ?? window, element.ownerDocument);
    draw(leaftailPortraitPose(0, true));
  }, [animated]);
  return <canvas ref={canvas} className={className} width={192} height={192} aria-hidden="true" />;
}

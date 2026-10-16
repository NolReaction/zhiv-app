"use client";

import { useEffect, useRef } from "react";
import { kamneshmygSprite } from "./kamneshmyg-sprite";
import { kamneshmygPortraitPose, startKamneshmygPortraitAnimation, type KamneshmygPortraitPose } from "./kamneshmyg-portrait-animation";

/** Decorative card view of the very same resident used on the map. */
export function KamneshmygPortrait({ className, animated = false }: { className?: string; animated?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current, ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    const draw = ({ action, frame, phase, still }: KamneshmygPortraitPose) => {
      ctx.clearRect(0, 0, 192, 192); ctx.imageSmoothingEnabled = false;
      ctx.drawImage(kamneshmygSprite(action, "front", frame, phase, still), 0, 0, 192, 192);
    };
    if (animated) return startKamneshmygPortraitAnimation(draw, element.ownerDocument.defaultView ?? window, element.ownerDocument);
    draw(kamneshmygPortraitPose(0, true));
  }, [animated]);
  return <canvas ref={canvas} className={className} width={192} height={192} aria-hidden="true" />;
}

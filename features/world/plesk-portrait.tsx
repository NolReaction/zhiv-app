"use client";

import { useEffect, useRef } from "react";
import { pleskSprite } from "./plesk-sprite";

/** The portrait uses the same resident art as the map, without another asset or
 * animation clock. Accessible names belong to the surrounding card/dialog. */
export function PleskPortrait({ className }: { className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, 96, 96); ctx.imageSmoothingEnabled = false;
    ctx.drawImage(pleskSprite("greet", "front", 0, .3, true), 6, 6, 84, 84);
  }, []);
  return <canvas ref={canvas} className={className} width={96} height={96} aria-hidden="true" />;
}

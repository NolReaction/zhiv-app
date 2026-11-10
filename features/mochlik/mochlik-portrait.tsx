"use client";

import { useEffect, useRef } from "react";
import { pixelSprite } from "./pixel-sprite";

type Appearance = { palette: string; head: string | null; neck: string | null };

/** A still frame of the real world sprite, without a second scene or game clock. */
export function MochlikPortrait({ appearance, className, label }: { appearance: Appearance; className?: string; label?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { palette, head, neck } = appearance;
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, 192, 192); ctx.imageSmoothingEnabled = false;
    ctx.drawImage(pixelSprite("idle", "front", 0, { palette, head, neck }), 0, 0, 192, 192);
  }, [palette, head, neck]);
  return <canvas ref={canvas} width={192} height={192} className={className} style={{ imageRendering: "pixelated" }}
    role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

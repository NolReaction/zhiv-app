"use client";

import { useEffect, useRef } from "react";
import { pixelSprite } from "@/features/mochlik/pixel-sprite";

/** Reuse the game's editable character rather than introducing another master. */
export function MochlikGuide({ className }: { className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, 192, 192);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(pixelSprite("greet", "front", 0), 0, 0, 192, 192);
  }, []);
  return <canvas ref={canvas} className={className} width={192} height={192} aria-hidden="true" />;
}

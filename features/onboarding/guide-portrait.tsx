"use client";

import { useEffect, useRef } from "react";
import { pixelSprite, type PixelPose } from "@/features/mochlik/pixel-sprite";
import { guidePortraitFrame, guidePortraitGestureDuration } from "./guide-portrait-animation";

export function GuidePortrait({ pose, stepId, className }: { pose: PixelPose; stepId: string; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let elapsed = 0, previousTime = performance.now(), previousFrame = "";
    const paint = () => {
      const { pose: currentPose, frame } = guidePortraitFrame(pose, elapsed, motion.matches);
      const key = `${currentPose}:${frame}`;
      if (key === previousFrame) return;
      previousFrame = key;
      ctx.clearRect(0, 0, 192, 192);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(pixelSprite(currentPose, "front", frame), 0, 0, 192, 192);
    };
    const tick = () => {
      timer = undefined;
      if (document.visibilityState === "hidden" || motion.matches) return;
      const now = performance.now();
      elapsed += now - previousTime;
      previousTime = now;
      paint();
      if (elapsed < guidePortraitGestureDuration(pose)) timer = setTimeout(tick, 100);
    };
    const resume = () => {
      clearTimeout(timer);
      timer = undefined;
      previousTime = performance.now();
      paint();
      if (document.visibilityState !== "hidden" && !motion.matches && elapsed < guidePortraitGestureDuration(pose)) timer = setTimeout(tick, 100);
    };
    resume();
    document.addEventListener("visibilitychange", resume);
    motion.addEventListener("change", resume);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      motion.removeEventListener("change", resume);
    };
  }, [pose, stepId]);
  return <canvas ref={canvas} className={className} width={192} height={192} data-guide-pose={pose} aria-hidden="true" />;
}

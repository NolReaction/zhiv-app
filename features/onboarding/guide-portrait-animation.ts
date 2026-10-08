import type { PixelPose } from "@/features/mochlik/pixel-sprite";

export type GuidePortraitFrame = { pose: PixelPose; frame: number };

/** A short gesture followed by a held pose keeps the guide lively without
 * repeating a wave or a deep bend throughout a longer explanation. */
export function guidePortraitFrame(pose: PixelPose, elapsedMs: number, reducedMotion = false): GuidePortraitFrame {
  const settledFrame = pose === "hold" || pose === "reach" ? 3 : pose === "greet" ? 1 : 0;
  if (reducedMotion) return { pose, frame: settledFrame };
  const elapsed = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0) % 5600;
  if (pose === "idle") return { pose: elapsed >= 4400 && elapsed < 4560 ? "blink" : "idle", frame: 0 };
  const tick = pose === "chew" ? 220 : pose === "wonder" ? 380 : 280;
  if (elapsed < tick * 4) return { pose, frame: Math.floor(elapsed / tick) };
  return { pose, frame: settledFrame };
}

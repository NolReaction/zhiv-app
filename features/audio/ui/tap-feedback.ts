import type { AudioRuntime } from "@/features/audio/domain/types";

const lastTap = new WeakMap<AudioRuntime, number>();
let sequence = 0;
export const TAP_AUDIO_INTERVAL_MS = 160;

/** Called only after a real tap has been saved. Burst input never queues sound;
 * the confirmed production power gently changes the existing rounded timbre. */
export function playTapFeedback(runtime: AudioRuntime, powerPercent: number, occurredAt = Date.now()) {
  const previous = lastTap.get(runtime);
  if (!Number.isFinite(occurredAt) || previous !== undefined && occurredAt >= previous
    && occurredAt - previous < TAP_AUDIO_INTERVAL_MS) return;
  lastTap.set(runtime, occurredAt);
  const power = Number.isFinite(powerPercent) ? Math.max(0, Math.min(1, powerPercent / 20)) : 0;
  runtime.play({ id: `tap:${++sequence}`, cueId: "ui.tap", occurredAt, maxAgeMs: 120,
    playbackRate: .9 + power * .26, gain: .7 + power * .2 });
}

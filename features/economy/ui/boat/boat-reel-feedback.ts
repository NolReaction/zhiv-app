import type { BoatReelState } from "@/features/economy/domain/boat-reel";

/** Feedback describes the same zone used by server replay; it never modifies a trace. */
export function boatReelFeedback(reel: Pick<BoatReelState, "bar" | "fish" | "progress">, zoneWidth: number) {
  const inZone = Math.abs(reel.fish - reel.bar) <= zoneWidth / 2;
  const direction = reel.fish > reel.bar ? "lift" : "ease";
  const urgent = !inZone && reel.progress <= 1500;
  const mood = inZone ? "steady" : urgent ? "danger" : "chase";
  const title = inZone ? reel.progress >= 8000 ? "Почти у борта" : "Рыба в зоне" : urgent ? "Рыба уходит!" : "Рыба тянет в сторону";
  const instruction = inZone ? "Чередуйте удержание и отпускание" : direction === "lift" ? "Удерживайте — поднимите снасть" : "Отпустите — опустите снасть";
  return { inZone, direction, urgent, mood, title, instruction } as const;
}

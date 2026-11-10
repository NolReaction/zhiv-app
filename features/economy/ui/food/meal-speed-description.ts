import { builderWorkDuration, mealDuration, mealWorkDuration } from "@/features/economy/domain/food";
import { worldRecipeDuration } from "@/features/economy/ui/stations/world-recipe-groups";

/** Describe time saved, rather than the inverse work-speed multiplier. */
export function mealSpeedDescription(speedBps: number, existingSpeedBps = 0) {
  const reduction = 100 * speedBps / (10_000 + existingSpeedBps + speedBps);
  const time = reduction.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  return `Время короче ${Number.isInteger(reduction) ? "на" : "примерно на"} ${time}%`;
}

export function mealTimeExample(speedBps: number, workSeconds?: number | null, consumer: "hero" | "builder" = "hero") {
  const after = consumer === "builder" ? builderWorkDuration(3600, speedBps, 0, workSeconds) : workSeconds == null ? mealDuration(3600, speedBps) : mealWorkDuration(3600, speedBps, workSeconds);
  return `1 ч → ${worldRecipeDuration(after)}`;
}

/** The allowance measures unboosted route work, not a countdown while idle. */
export function mealWorkDescription(workSeconds?: number | null, consumer: "hero" | "builder" = "hero") {
  if (consumer === "builder") return workSeconds ? `Хватит на ${worldRecipeDuration(workSeconds)} обычной работы. Остаток стройки без еды; порция не переносится.` : "Действует на одну стройку.";
  return workSeconds ? `Хватит на ${worldRecipeDuration(workSeconds)} вылазок без еды. Остаток сохраняется между походами; в отдыхе не тратится.`
    : "Действует на одну вылазку.";
}

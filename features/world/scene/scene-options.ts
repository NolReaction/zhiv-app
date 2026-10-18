import type { SceneOptions } from "@/features/mochlik/scene";

/** Immutable scene inputs may be repackaged by UI without changing the world. */
export function sameSceneOptions(previous: SceneOptions, next: SceneOptions): boolean {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)] as (keyof SceneOptions)[]);
  for (const key of keys) {
    if (Object.is(previous[key], next[key])) continue;
    if (key === "residentArrival" || key === "merchantArrival") {
      const before = previous[key], after = next[key];
      if (before && after && before.seen === after.seen && before.enabled === after.enabled
        && before.onComplete === after.onComplete) continue;
    }
    return false;
  }
  return true;
}

import type { FishingPropFrame } from "@/features/world/activities/fishing/fishing-props";
import { sampleForestWater, type ForestWaterDynamics } from "./forest-water-dynamics";

/** Read-only visual feedback: the tethered float follows the surface without
 * changing the fishing target, cast timing, rewards or character's stance. */
export function withForestWaterBuoyancy<T extends FishingPropFrame>(frame: T, water: ForestWaterDynamics | undefined, still: boolean): T {
  if (!water || still || !frame.waterTarget || frame.settling) return frame;
  const sample = sampleForestWater(water, frame.waterTarget);
  return { ...frame, waterDisplacement: {
    x: Math.max(-1, Math.min(1, sample.slopeX * .6)) * water.scale,
    y: Math.max(-1.7, Math.min(1.7, -sample.height * 1.8)) * water.scale,
  } };
}

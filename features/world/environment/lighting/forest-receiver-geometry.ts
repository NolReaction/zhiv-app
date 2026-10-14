import type { WorldPoint } from "@/features/world/tiled/types";
import { validateForestReceiverHoles as validateHoles } from "./forest-receiver-geometry.mjs";
export { FOREST_RECEIVER_MAX_HOLES, FOREST_RECEIVER_MAX_VERTICES } from "./forest-receiver-geometry.mjs";

/** Shared with the authoring compiler to reject malformed or crossing exclusions. */
export function validateForestReceiverHoles(points: readonly WorldPoint[], holes: unknown): string | null {
  return validateHoles(points, holes);
}

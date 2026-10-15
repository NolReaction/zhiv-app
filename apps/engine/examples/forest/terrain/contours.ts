import { createWaterContourCache as createCache } from "@/packages/engine/src/terrain/contours";
import { sampleWaterSignedDistance } from "./layout";
export { marchingSquares } from "@/packages/engine/src/terrain/contours";
export type { WaterContour } from "@/packages/engine/src/terrain/contours";
export const createWaterContourCache = () => createCache({ width: 3200, height: 1600 }, sampleWaterSignedDistance);

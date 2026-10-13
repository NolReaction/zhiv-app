import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import { containsDynamicsWater, createDynamicsGeometry, dynamicsCellAt, dynamicsPathIsWet,
  WATER_DYNAMICS_LIMITS, type WaterDynamicsGeometry } from "./water-dynamics-geometry";
import { advanceDynamicsLeaves, createDynamicsFlow, type WaterDynamicsLeaf } from "./water-dynamics-flow";

export { WATER_DYNAMICS_LIMITS } from "./water-dynamics-geometry";
export type ForestWaterDynamics = {
  columns: number; rows: number; cellSize: number; origin: WorldPoint; scale: number;
  mask: Uint8Array; active: Uint32Array; neighbours: Int32Array;
  heights: Float32Array; velocities: Float32Array; flowX: Float32Array; flowY: Float32Array;
  leaves: WaterDynamicsLeaf[]; elapsed: number; revision: number;
  geometry: WaterDynamicsGeometry; accumulator: number; rainAccumulator: number; rainSequence: number;
};
type DynamicsWeather = { rain: number; wind: number; reducedMotion?: boolean };
type Disturbance = { strength?: number; radius?: number };
const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const FIXED_STEP = WATER_DYNAMICS_LIMITS.fixedStep;

/** Pure session-owned simulation. Geometry is shared read-only, but every session
 * gets its own height, velocity, flow and leaf arrays, including empty old maps. */
export function createForestWaterDynamics(scene: FixedWorldScene): ForestWaterDynamics {
  const geometry = createDynamicsGeometry(scene);
  const { columns, rows, cellSize, origin, scale, mask, active, neighbours } = geometry;
  return { columns, rows, cellSize, origin, scale, mask, active, neighbours, geometry,
    heights: new Float32Array(mask.length), velocities: new Float32Array(mask.length), ...createDynamicsFlow(geometry),
    elapsed: 0, revision: 0, accumulator: 0, rainAccumulator: 0, rainSequence: 0 };
}

/** A compact, zero-integral displacement gives a visible outward wave without
 * progressively filling the river. Impulses cannot jump across authored land. */
export function disturbForestWater(state: ForestWaterDynamics, point: WorldPoint, options: Disturbance = {}) {
  if (!containsDynamicsWater(state.geometry, point) || !state.active.length) return false;
  const strength = clamp(finite(options.strength ?? 1), -3, 3);
  if (!strength) return false;
  const radius = clamp(finite(options.radius ?? 12 * state.scale, 12 * state.scale), state.cellSize * 1.5, Math.max(state.cellSize * 1.5, 48 * state.scale));
  const { origin, cellSize, columns, rows, mask, heights } = state;
  const startX = Math.max(0, Math.floor((point.x - radius - origin.x) / cellSize));
  const endX = Math.min(columns - 1, Math.floor((point.x + radius - origin.x) / cellSize));
  const startY = Math.max(0, Math.floor((point.y - radius - origin.y) / cellSize));
  const endY = Math.min(rows - 1, Math.floor((point.y + radius - origin.y) / cellSize));
  let changed = false;
  for (let row = startY; row <= endY; row++) for (let column = startX; column <= endX; column++) {
    const index = row * columns + column; if (!mask[index]) continue;
    const target = { x: origin.x + (column + .5) * cellSize, y: origin.y + (row + .5) * cellSize };
    const squared = ((target.x - point.x) ** 2 + (target.y - point.y) ** 2) / (radius * radius);
    if (squared >= 1 || !dynamicsPathIsWet(state.geometry, point, target)) continue;
    const pulse = (1 - squared) ** 2 * (1 - 4 * squared);
    heights[index] = clamp(heights[index] + pulse * strength, -4, 4); changed = true;
  }
  if (changed) state.revision++;
  return changed;
}

function forceWeather(state: ForestWaterDynamics, rain: number, wind: number) {
  if (rain > 0) {
    state.rainAccumulator += FIXED_STEP * rain * 7;
    if (state.rainAccumulator >= 1) {
      state.rainAccumulator -= 1;
      const order = state.rainSequence++, index = state.active[(Math.imul(order + 1, 15485863) >>> 0) % state.active.length];
      disturbForestWater(state, { x: state.origin.x + (index % state.columns + .5) * state.cellSize,
        y: state.origin.y + (Math.floor(index / state.columns) + .5) * state.cellSize }, { strength: .12, radius: 7 * state.scale });
    }
  } else state.rainAccumulator = 0;
  if (wind <= 0) return;
  // Smooth forcing is applied to a bounded seed set; the wave equation carries
  // it across the rest of the river, rather than evaluating trig per wet cell.
  const count = Math.min(18, state.active.length);
  for (let i = 0; i < count; i++) {
    const index = state.active[Math.floor((i + .5) * state.active.length / count)];
    state.velocities[index] += Math.sin(state.elapsed * 2.6 + i * 2.39996) * wind * .55 * FIXED_STEP;
  }
}

function step(state: ForestWaterDynamics, rain: number, wind: number) {
  forceWeather(state, rain, wind);
  const { heights, velocities, neighbours } = state;
  // Semi-implicit integration of h'' = c² ∇²h - damping*h'. With c*dt/dx
  // capped at .3 (< 1/sqrt(2)), the 2-D grid remains stable at every map scale.
  const speed = Math.min(42 * state.scale, state.cellSize * .3 / FIXED_STEP);
  const acceleration = speed * speed / (state.cellSize * state.cellSize) * FIXED_STEP;
  const velocityDamping = Math.exp(-1.15 * FIXED_STEP), heightDamping = Math.exp(-.08 * FIXED_STEP);
  for (const index of state.active) {
    const neighbour = index * 4;
    const laplacian = heights[neighbours[neighbour]] + heights[neighbours[neighbour + 1]]
      + heights[neighbours[neighbour + 2]] + heights[neighbours[neighbour + 3]] - 4 * heights[index];
    velocities[index] = clamp((velocities[index] + laplacian * acceleration) * velocityDamping, -32, 32);
  }
  for (const index of state.active) heights[index] = clamp((heights[index] + velocities[index] * FIXED_STEP) * heightDamping, -4, 4);
  state.elapsed += FIXED_STEP;
  advanceDynamicsLeaves(state.geometry, state.flowX, state.flowY, state.leaves, state.elapsed, FIXED_STEP);
  state.revision++;
}

/** Seconds of active time only. Long frames discard catch-up debt; visibility and
 * reduced-motion pauses cannot produce an explosive jump when play resumes. */
export function advanceForestWaterDynamics(state: ForestWaterDynamics, dt: number, weather: DynamicsWeather) {
  if (weather.reducedMotion || !state.active.length) { state.accumulator = 0; return; }
  if (!Number.isFinite(dt) || dt <= 0) return;
  const rain = clamp(finite(weather.rain), 0, 1), wind = clamp(finite(weather.wind), 0, 1);
  state.accumulator += Math.min(dt, FIXED_STEP * WATER_DYNAMICS_LIMITS.catchUpSteps);
  let steps = 0;
  while (state.accumulator + 1e-9 >= FIXED_STEP && steps++ < WATER_DYNAMICS_LIMITS.catchUpSteps) {
    step(state, rain, wind); state.accumulator = Math.max(0, state.accumulator - FIXED_STEP);
  }
}

/** Local height/slope sampling respects blocked neighbours at shores. The surface
 * stays readable by floats and painters without advancing the simulation. */
export function sampleForestWater(state: ForestWaterDynamics, point: WorldPoint) {
  const index = dynamicsCellAt(state.geometry, point);
  if (index < 0 || !state.mask[index] || !containsDynamicsWater(state.geometry, point)) return { height: 0, slopeX: 0, slopeY: 0, flowX: 0, flowY: 0 };
  const { heights, neighbours, cellSize } = state, left = neighbours[index * 4], right = neighbours[index * 4 + 1];
  const up = neighbours[index * 4 + 2], down = neighbours[index * 4 + 3];
  const dx = (point.x - state.origin.x) / cellSize - (index % state.columns + .5);
  const dy = (point.y - state.origin.y) / cellSize - (Math.floor(index / state.columns) + .5);
  const slopeX = (heights[right] - heights[left]) / (2 * cellSize), slopeY = (heights[down] - heights[up]) / (2 * cellSize);
  return { height: heights[index] + slopeX * dx * cellSize + slopeY * dy * cellSize, slopeX, slopeY,
    flowX: state.flowX[index], flowY: state.flowY[index] };
}

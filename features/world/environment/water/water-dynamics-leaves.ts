import type { WorldPoint } from "@/features/world/tiled/types";
import { dynamicsCellAt, dynamicsFootprintFits, dynamicsPathIsWet, type WaterDynamicsGeometry } from "./water-dynamics-geometry";

export type WaterDynamicsLeaf = {
  id: number; x: number; y: number; rotation: number; size: number; opacity: number;
  vx: number; vy: number; angularVelocity: number; bob: number;
  submersion: number; submersionVelocity: number; shape: number;
};
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const limitVelocity = (leaf: WaterDynamicsLeaf, scale: number) => {
  const speed = Math.hypot(leaf.vx, leaf.vy), limit = 18 * scale;
  if (speed > limit) { leaf.vx *= limit / speed; leaf.vy *= limit / speed; }
};

/** The enclosing circle contains the entire swept leaf footprint. This is
 * conservative at corners, but cannot tunnel through even a sub-grid island. */
function moveLeaf(geometry: WaterDynamicsGeometry, leaf: WaterDynamicsLeaf, x: number, y: number) {
  const target = { x, y }, middle = { x: (leaf.x + x) / 2, y: (leaf.y + y) / 2 };
  if (!dynamicsFootprintFits(geometry, middle, leaf.size + .6 * geometry.scale + Math.hypot(x - leaf.x, y - leaf.y) / 2)
    || !dynamicsPathIsWet(geometry, leaf, target)) return false;
  leaf.x = x; leaf.y = y; return true;
}

/** Touch impulses only cross connected water, and do not depend on camera zoom.
 * A direct hit depresses the leaf's spring, which emits one ripple on return. */
export function touchDynamicsLeaves(geometry: WaterDynamicsGeometry, leaves: WaterDynamicsLeaf[], point: WorldPoint) {
  const radius = 25 * geometry.scale;
  for (const leaf of leaves) {
    const dx = leaf.x - point.x, dy = leaf.y - point.y, distance = Math.hypot(dx, dy);
    if (distance > radius || !dynamicsPathIsWet(geometry, point, leaf)) continue;
    const angle = distance > .01 * geometry.scale ? Math.atan2(dy, dx) : leaf.rotation + Math.PI / 2;
    const direct = distance < leaf.size + 1.2 * geometry.scale;
    const strength = (1 - distance / radius) * (direct ? 2.5 : 11) * geometry.scale;
    leaf.vx += Math.cos(angle) * strength; leaf.vy += Math.sin(angle) * strength;
    leaf.angularVelocity = clamp(leaf.angularVelocity + Math.sin(angle - leaf.rotation) * .8, -2.5, 2.5);
    if (direct) { leaf.submersion = Math.max(.22, leaf.submersion); leaf.submersionVelocity = 2.5; }
    limitVelocity(leaf, geometry.scale);
  }
}

function resolveLeafContacts(geometry: WaterDynamicsGeometry, leaves: WaterDynamicsLeaf[], dt: number) {
  for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
    const first = leaves[i], second = leaves[j], dx = second.x - first.x, dy = second.y - first.y;
    const distance = Math.hypot(dx, dy), separation = (first.size + second.size) * .82;
    if (distance >= separation || !dynamicsPathIsWet(geometry, first, second)) continue;
    const angle = distance > .0001 * geometry.scale ? Math.atan2(dy, dx) : (first.id + second.id + 1) * 2.39996;
    const nx = Math.cos(angle), ny = Math.sin(angle), overlap = separation - distance;
    const closing = Math.min(0, (second.vx - first.vx) * nx + (second.vy - first.vy) * ny);
    const impulse = overlap * 14 * dt - closing * .35;
    first.vx -= nx * impulse; first.vy -= ny * impulse;
    second.vx += nx * impulse; second.vy += ny * impulse;
    const slip = (second.vx - first.vx) * -ny + (second.vy - first.vy) * nx;
    first.angularVelocity = clamp(first.angularVelocity + slip / geometry.scale * dt * .3, -2.5, 2.5);
    second.angularVelocity = clamp(second.angularVelocity - slip / geometry.scale * dt * .3, -2.5, 2.5);
    // Small positional relaxation prevents piles that continue interpenetrating;
    // each move still checks the complete footprint and the path to it.
    const correction = Math.min(overlap * .18, .18 * geometry.scale);
    moveLeaf(geometry, first, first.x - nx * correction, first.y - ny * correction);
    moveLeaf(geometry, second, second.x + nx * correction, second.y + ny * correction);
    limitVelocity(first, geometry.scale); limitVelocity(second, geometry.scale);
  }
}

export function advanceDynamicsLeaves(geometry: WaterDynamicsGeometry, flowX: Float32Array, flowY: Float32Array,
  heights: Float32Array, leaves: WaterDynamicsLeaf[], elapsed: number, dt: number, wind: number,
  resurface: (point: WorldPoint) => void) {
  const { scale, neighbours, cellSize } = geometry;
  resolveLeafContacts(geometry, leaves, dt);
  for (const leaf of leaves) {
    const index = dynamicsCellAt(geometry, leaf);
    if (index < 0 || !geometry.mask[index]) continue;
    const slopeX = (heights[neighbours[index * 4 + 1]] - heights[neighbours[index * 4]]) / (2 * cellSize);
    const slopeY = (heights[neighbours[index * 4 + 3]] - heights[neighbours[index * 4 + 2]]) / (2 * cellSize);
    const gust = wind * (.7 + .3 * Math.sin(elapsed * .63 + leaf.id)) * scale;
    const x = flowX[index] + gust + Math.sin(elapsed * .47 + leaf.id * 3.7) * .22 * scale;
    const y = flowY[index] - gust * .28 + Math.cos(elapsed * .39 + leaf.id * 2.1) * .17 * scale;
    const drag = 1 - Math.exp(-2.1 * dt);
    leaf.vx += (x - leaf.vx) * drag - slopeX * 65 * scale * scale * dt;
    leaf.vy += (y - leaf.vy) * drag - slopeY * 65 * scale * scale * dt;
    limitVelocity(leaf, scale);
    if (!moveLeaf(geometry, leaf, leaf.x + leaf.vx * dt, leaf.y + leaf.vy * dt)) {
      // Follow a blocked bank tangentially, losing energy instead of reflecting
      // at full speed. Both candidate directions use the same exact fence.
      const vx = leaf.vx, vy = leaf.vy;
      if (moveLeaf(geometry, leaf, leaf.x - vy * dt * .55, leaf.y + vx * dt * .55)) {
        leaf.vx = -vy * .55; leaf.vy = vx * .55;
      } else if (moveLeaf(geometry, leaf, leaf.x + vy * dt * .55, leaf.y - vx * dt * .55)) {
        leaf.vx = vy * .55; leaf.vy = -vx * .55;
      } else { leaf.vx *= .35; leaf.vy *= .35; }
      leaf.angularVelocity = clamp(leaf.angularVelocity + .55 * dt, -2.5, 2.5);
    }
    const wanted = Math.atan2(leaf.vy, leaf.vx) + Math.sin(elapsed * .61 + leaf.id) * .2;
    const difference = Math.atan2(Math.sin(wanted - leaf.rotation), Math.cos(wanted - leaf.rotation));
    leaf.angularVelocity += (difference * 1.6 - leaf.angularVelocity * 2.4) * dt;
    leaf.rotation = (leaf.rotation + leaf.angularVelocity * dt) % (Math.PI * 2);
    leaf.bob += (clamp(heights[index] * scale * .6, -1.4 * scale, 1.4 * scale) - leaf.bob) * (1 - Math.exp(-10 * dt));
    if (leaf.submersion > 0 || leaf.submersionVelocity > 0) {
      leaf.submersionVelocity += (-38 * leaf.submersion - 5.5 * leaf.submersionVelocity) * dt;
      const depth = leaf.submersion + leaf.submersionVelocity * dt;
      leaf.submersion = clamp(depth, 0, 1);
      if (depth <= 0) { leaf.submersionVelocity = 0; resurface(leaf); }
      else if (depth >= 1) leaf.submersionVelocity = Math.min(0, leaf.submersionVelocity);
    }
  }
}

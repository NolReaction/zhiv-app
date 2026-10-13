import { previewPointInPolygon } from "@/features/world/tiled/preview-state";
import type { FixedWorldScene, WorldBounds, WorldPoint } from "@/features/world/tiled/types";

export const FOREST_TREE_INTERACTION_LIMITS = {
  bursts: 6, leaves: 40, leavesPerTouch: 7, cooldown: .35, treeCooldown: .7, shakeSeconds: 1.25,
} as const;

export type ForestTreeCrown = {
  id: string; points: WorldPoint[]; bounds: WorldBounds; frontY: number;
  left: number; top: number; right: number; bottom: number;
};
export type ForestTreeBurst = { tree: ForestTreeCrown; age: number; direction: number };
export type ForestFallingLeaf = {
  x: number; y: number; originX: number; originY: number; vx: number; fall: number;
  age: number; lifetime: number; phase: number; flutter: number; rotation: number;
  size: number; shape: number; opacity: number;
};
export type ForestTreeInteractions = {
  crowns: ForestTreeCrown[]; bursts: ForestTreeBurst[]; leaves: ForestFallingLeaf[];
  scale: number; elapsed: number; sequence: number; lastTouch: number; treeTouches: Map<string, number>;
};
type TreeInteractionOptions = { paused?: boolean; reducedMotion?: boolean };
const geometry = new WeakMap<FixedWorldScene, ForestTreeCrown[]>();
const finitePoint = (point: WorldPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);
const noise = (seed: number) => { const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value); };

function crownsFor(scene: FixedWorldScene): ForestTreeCrown[] {
  const cached = geometry.get(scene); if (cached) return cached;
  const crowns: ForestTreeCrown[] = [];
  for (const mask of scene.occluders ?? []) {
    // These are the authored tree silhouettes. Rocks, the shop counter and
    // building masks have different IDs and must never shed leaves.
    if (!/(?:^|-)(?:canopy|tree)$/.test(mask.id) || !Number.isFinite(mask.frontY)
      || mask.points.length < 3 || mask.points.some(point => !finitePoint(point))) continue;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const point of mask.points) {
      left = Math.min(left, point.x); top = Math.min(top, point.y);
      right = Math.max(right, point.x); bottom = Math.max(bottom, point.y);
    }
    if (right <= left || bottom <= top) continue;
    crowns.push({ id: mask.id, points: mask.points, frontY: mask.frontY, left, top, right, bottom,
      bounds: { x: left, y: top, width: right - left, height: bottom - top } });
  }
  crowns.sort((a, b) => b.frontY - a.frontY);
  geometry.set(scene, crowns); return crowns;
}

export function createForestTreeInteractions(scene: FixedWorldScene): ForestTreeInteractions {
  return { crowns: crownsFor(scene), bursts: [], leaves: [], scale: Math.max(.1, Math.min(scene.width, scene.height) / 1254),
    elapsed: 0, sequence: 0, lastTouch: -Infinity, treeTouches: new Map() };
}

function contains(crown: ForestTreeCrown, point: WorldPoint) {
  return point.x >= crown.left && point.x <= crown.right && point.y >= crown.top && point.y <= crown.bottom
    && previewPointInPolygon(point, crown.points);
}

/** World-space hit testing is independent of animation/cooldown. A repeated tap
 * remains a tree tap instead of falling through to the hidden hero or water. */
export function hitForestTree(state: ForestTreeInteractions, point: WorldPoint): ForestTreeCrown | null {
  if (!finitePoint(point)) return null;
  return state.crowns.find(crown => contains(crown, point)) ?? null;
}

function leafOrigin(crown: ForestTreeCrown, contact: WorldPoint, seed: number, scale: number): WorldPoint {
  // A bounded local rejection sample follows the exact authored crown, including
  // concave branches. Its fallback is the already-validated contact itself.
  const spreadX = Math.min(crown.bounds.width * .32, 25 * scale);
  const spreadY = Math.min(crown.bounds.height * .24, 17 * scale);
  for (let attempt = 0; attempt < 12; attempt++) {
    const point = { x: contact.x + (noise(seed + attempt * 7 + 1) - .5) * spreadX * 2,
      y: contact.y + (noise(seed + attempt * 7 + 2) - .65) * spreadY * 2 };
    if (contains(crown, point)) return point;
  }
  return { x: contact.x, y: contact.y };
}

/** One quiet sound may accompany an accepted contact; rendering never emits it.
 * `now` is monotonic seconds and is independent of a paused animation clock. */
export function touchForestTree(state: ForestTreeInteractions, point: WorldPoint,
  options: TreeInteractionOptions & { now?: number } = {}): { treeId: string; point: WorldPoint } | null {
  if (options.paused) return null;
  const crown = hitForestTree(state, point); if (!crown) return null;
  const now = options.now ?? state.elapsed;
  if (!Number.isFinite(now) || now < state.lastTouch + FOREST_TREE_INTERACTION_LIMITS.cooldown
    || now < (state.treeTouches.get(crown.id) ?? -Infinity) + FOREST_TREE_INTERACTION_LIMITS.treeCooldown) return null;
  state.lastTouch = now; state.treeTouches.set(crown.id, now); state.sequence++;
  if (!options.reducedMotion) {
    const direction = point.x < (crown.left + crown.right) / 2 ? 1 : -1;
    const existing = state.bursts.find(burst => burst.tree.id === crown.id);
    if (existing) { existing.age = 0; existing.direction = direction; }
    else {
      if (state.bursts.length >= FOREST_TREE_INTERACTION_LIMITS.bursts) state.bursts.shift();
      state.bursts.push({ tree: crown, age: 0, direction });
    }
    for (let index = 0; index < FOREST_TREE_INTERACTION_LIMITS.leavesPerTouch; index++) {
      const seed = state.sequence * 97 + index * 29, origin = leafOrigin(crown, point, seed, state.scale);
      if (state.leaves.length >= FOREST_TREE_INTERACTION_LIMITS.leaves) state.leaves.shift();
      state.leaves.push({ x: origin.x, y: origin.y, originX: origin.x, originY: origin.y,
        age: -.03 - noise(seed + 3) * .2, lifetime: 2.5 + noise(seed + 4) * 1.3,
        vx: (direction * 2 + (noise(seed + 5) - .5) * 13) * state.scale,
        fall: (12 + noise(seed + 6) * 12) * state.scale,
        phase: noise(seed + 7) * Math.PI * 2, flutter: (2.5 + noise(seed + 8) * 3.5) * state.scale,
        rotation: noise(seed + 9) * Math.PI * 2, size: (2.7 + noise(seed + 10) * 1.8) * state.scale,
        shape: Math.floor(noise(seed + 11) * 3), opacity: 0 });
    }
  }
  return { treeId: crown.id, point: { x: point.x, y: point.y } };
}

/** In-place compaction and analytic trajectories keep frame work bounded. A
 * suspended view does not integrate a long wall-clock gap or replay contacts. */
export function advanceForestTreeInteractions(state: ForestTreeInteractions, dt: number, options: TreeInteractionOptions = {}) {
  if (options.reducedMotion) { state.bursts.length = 0; state.leaves.length = 0; return; }
  if (options.paused || !Number.isFinite(dt) || dt <= 0) return;
  const step = Math.min(.1, dt); state.elapsed += step;
  let write = 0;
  for (const burst of state.bursts) {
    burst.age += step;
    if (burst.age < FOREST_TREE_INTERACTION_LIMITS.shakeSeconds) state.bursts[write++] = burst;
  }
  state.bursts.length = write; write = 0;
  for (const leaf of state.leaves) {
    leaf.age += step;
    if (leaf.age >= leaf.lifetime) continue;
    state.leaves[write++] = leaf;
    if (leaf.age < 0) continue;
    const age = leaf.age;
    leaf.x = leaf.originX + leaf.vx * age + (Math.sin(leaf.phase + age * 4.1) - Math.sin(leaf.phase)) * leaf.flutter;
    leaf.y = leaf.originY + leaf.fall * age + age * age * 2 * state.scale
      + (Math.cos(leaf.phase + age * 3.2) - Math.cos(leaf.phase)) * leaf.flutter * .4;
    leaf.rotation += step * (leaf.shape === 1 ? -1.6 : 1.3);
    leaf.opacity = Math.min(1, age / .12, (leaf.lifetime - age) / .6);
  }
  state.leaves.length = write;
}

export function clearForestTreeInteractions(state: ForestTreeInteractions) {
  state.bursts.length = 0; state.leaves.length = 0;
  state.treeTouches.clear(); state.lastTouch = -Infinity;
}

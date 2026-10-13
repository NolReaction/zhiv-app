import { dynamicsCellAt, dynamicsFootprintFits, dynamicsPathIsWet, WATER_DYNAMICS_LIMITS, type WaterDynamicsGeometry } from "./water-dynamics-geometry";

export type WaterDynamicsLeaf = { id: number; x: number; y: number; rotation: number; size: number; opacity: number };
const noise = (index: number) => { const value = Math.sin(index * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value); };

/** This is an artistic current along the river, not a depth/volume solver.
 * The cached bank gradient projects drift along shores and around exclusions. */
export function createDynamicsFlow(geometry: WaterDynamicsGeometry) {
  const { columns, origin, cellSize, scale, mask, shoreDistance } = geometry;
  const flowX = new Float32Array(mask.length), flowY = new Float32Array(mask.length);
  for (const index of geometry.active) {
    const column = index % columns, row = Math.floor(index / columns);
    let x = .35 + Math.sin(row * .057) * .45, y = .8 + Math.sin(column * .071) * .15;
    const gx = (shoreDistance[index + 1] ?? 0) - (shoreDistance[index - 1] ?? 0);
    const gy = (shoreDistance[index + columns] ?? 0) - (shoreDistance[index - columns] ?? 0);
    const length = Math.hypot(gx, gy), distance = shoreDistance[index];
    if (distance <= 4 && length > 0) {
      const nx = gx / length, ny = gy / length, intoLand = Math.min(0, x * nx + y * ny);
      x -= intoLand * nx; y -= intoLand * ny;
      // A slight inward drift keeps leaves from sticking to a stair-stepped bank.
      x += nx * .18 / distance; y += ny * .18 / distance;
    }
    const speed = Math.min(1, distance / 3) * 2.8 * scale / Math.max(.5, Math.hypot(x, y));
    flowX[index] = x * speed; flowY[index] = y * speed;
  }
  const leaves: WaterDynamicsLeaf[] = [];
  const desired = Math.min(WATER_DYNAMICS_LIMITS.leaves, Math.ceil(geometry.active.length / 1100));
  for (let id = 0; id < desired; id++) {
    const size = (2.2 + noise(id + 113) * 1.1) * scale;
    for (let attempt = 0; attempt < 160; attempt++) {
      const index = geometry.active[Math.floor(noise(id * 197 + attempt * 19 + 701) * geometry.active.length)];
      const point = { x: origin.x + (index % columns + .5) * cellSize, y: origin.y + (Math.floor(index / columns) + .5) * cellSize };
      if (!dynamicsFootprintFits(geometry, point, size + .6 * scale)) continue;
      if (leaves.some(leaf => Math.hypot(leaf.x - point.x, leaf.y - point.y) < 45 * scale)) continue;
      leaves.push({ id, ...point, size, rotation: noise(id + 99) * Math.PI * 2, opacity: .64 + noise(id + 13) * .18 }); break;
    }
  }
  return { flowX, flowY, leaves };
}

export function advanceDynamicsLeaves(geometry: WaterDynamicsGeometry, flowX: Float32Array, flowY: Float32Array,
  leaves: WaterDynamicsLeaf[], elapsed: number, dt: number) {
  for (const leaf of leaves) {
    const index = dynamicsCellAt(geometry, leaf);
    if (index < 0) continue;
    const x = flowX[index] + Math.sin(elapsed * .47 + leaf.id * 3.7) * .22 * geometry.scale;
    const y = flowY[index] + Math.cos(elapsed * .39 + leaf.id * 2.1) * .17 * geometry.scale;
    const target = { x: leaf.x + x * dt, y: leaf.y + y * dt };
    const fits = (point: { x: number; y: number }) => dynamicsFootprintFits(geometry, point, leaf.size + .6 * geometry.scale)
      && dynamicsPathIsWet(geometry, leaf, point);
    if (fits(target)) { leaf.x = target.x; leaf.y = target.y; }
    else {
      const tangent = { x: leaf.x - y * dt, y: leaf.y + x * dt };
      if (fits(tangent)) { leaf.x = tangent.x; leaf.y = tangent.y; }
    }
    const wanted = Math.atan2(y, x) + Math.sin(elapsed * .61 + leaf.id) * .2;
    const difference = Math.atan2(Math.sin(wanted - leaf.rotation), Math.cos(wanted - leaf.rotation));
    leaf.rotation += difference * Math.min(1, dt * .8);
  }
}

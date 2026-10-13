import { dynamicsFootprintFits, WATER_DYNAMICS_LIMITS, type WaterDynamicsGeometry } from "./water-dynamics-geometry";
import type { WaterDynamicsLeaf } from "./water-dynamics-leaves";

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
      leaves.push({ id, ...point, size, rotation: noise(id + 99) * Math.PI * 2, opacity: .64 + noise(id + 13) * .18,
        vx: flowX[index], vy: flowY[index], angularVelocity: 0, bob: 0, submersion: 0, submersionVelocity: 0, shape: id % 3 }); break;
    }
  }
  return { flowX, flowY, leaves };
}

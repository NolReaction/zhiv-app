import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { compileWaterRenderBoundary: compile } = await vite.ssrLoadModule("/features/world/environment/water/water-render-boundary.ts");
const polygon = points => ({ points: points.map(([x, y]) => ({ x, y })) });
const rectangle = (x, y, width, height) => polygon([[x, y], [x + width, y], [x + width, y + height], [x, y + height]]);
const reverse = shape => ({ points: [...shape.points].reverse() });

// Independent ray crossings, rather than the compiler's winding classifier.
function inside(points, point) {
  let hits = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < a.x + (point.y - a.y) * (b.x - a.x) / (b.y - a.y)) hits++;
  }
  return hits % 2 === 1;
}
function expected(water, point) {
  return water.surfaces.some(shape => inside(shape.points, point))
    && !water.exclusions.some(shape => inside(shape.points, point));
}
function compiledContains(result, point) {
  return result.rings.filter(ring => inside(ring, point)).length % 2 === 1;
}
function compare(water, points) {
  const result = compile(water);
  assert.ok(result, "a bounded valid arrangement compiles");
  for (const point of points) assert.equal(compiledContains(result, point), expected(water, point), JSON.stringify(point));
  return result;
}
function grid(left, top, width, height, count = 30) {
  return Array.from({ length: count * count }, (_, index) => ({
    x: left + (index % count + .371) * width / count,
    y: top + (Math.floor(index / count) + .619) * height / count,
  }));
}

test("compiled rings subtract overlapping reversed holes from the union of overlapping surfaces", () => {
  const water = { surfaces: [rectangle(0, 0, 100, 100), reverse(rectangle(50, 20, 100, 100))],
    exclusions: [rectangle(15, 15, 50, 50), reverse(rectangle(35, 35, 50, 50)), rectangle(60, 60, 40, 40)] };
  compare(water, grid(-10, -10, 170, 140));
});

test("collinear shared borders, coincident holes and touching corners retain the wet union", () => {
  for (const water of [
    { surfaces: [rectangle(0, 0, 50, 100), reverse(rectangle(50, 0, 50, 100))], exclusions: [] },
    { surfaces: [rectangle(0, 0, 50, 50), rectangle(50, 50, 50, 50)], exclusions: [] },
    { surfaces: [rectangle(0, 0, 100, 100)], exclusions: [rectangle(20, 20, 30, 30), reverse(rectangle(20, 20, 30, 30))] },
    { surfaces: [rectangle(0, 0, 100, 100)], exclusions: [rectangle(20, 20, 30, 30), rectangle(50, 50, 30, 30)] },
    { surfaces: [rectangle(0, 0, 100, 100)], exclusions: [rectangle(-10, 20, 60, 20), rectangle(50, 20, 60, 20)] },
  ]) compare(water, grid(-20, -20, 140, 140));
});

test("tiny holes and narrow wet strips remain present without rounding or simplification", () => {
  const gap = .00001;
  const water = { surfaces: [rectangle(0, 0, 100, 100)], exclusions: [
    rectangle(10, -10, 20, 120), rectangle(30 + gap, -10, 20, 120), rectangle(70, 70, .0001, .0001),
  ] };
  compare(water, [
    { x: 30 + gap / 2, y: 50 }, { x: 30 - gap / 2, y: 50 }, { x: 30 + gap * 1.5, y: 50 },
    { x: 70.00005, y: 70.00005 }, { x: 70.00015, y: 70.00005 }, ...grid(0, 0, 100, 100),
  ]);
});

test("author-created collinear vertices remain in the final boundary", () => {
  const surface = polygon([[0, 0], [25, 0], [50, 0], [100, 0], [100, 100], [0, 100]]);
  const hole = polygon([[20, 20], [30, 20], [40, 20], [40, 40], [20, 40]]);
  const result = compare({ surfaces: [surface], exclusions: [hole] }, grid(0, 0, 100, 100));
  for (const point of [...surface.points, ...hole.points]) assert.ok(result.rings.some(ring => ring.includes(point)),
    "the boundary keeps the actual authored point object");
});

test("fully removed water is a valid empty boundary", () => {
  const result = compile({ surfaces: [rectangle(0, 0, 100, 100)], exclusions: [rectangle(-1, -1, 102, 102)] });
  assert.ok(result); assert.deepEqual(result.rings, []);
});

test("unsafe, degenerate and oversized inputs keep the exact legacy mask available", () => {
  for (const water of [
    { surfaces: [polygon([[0, 0], [0, 0], [10, 10]])], exclusions: [] },
    { surfaces: [polygon([[0, 0], [10, 0], [Infinity, 10]])], exclusions: [] },
    { surfaces: [rectangle(0, 0, 100, 100)], exclusions: [polygon([[1, 1], [2, 2], [3, 3]])] },
    { surfaces: Array.from({ length: 1025 }, (_, index) => rectangle(index * 2, 0, 1, 1)), exclusions: [] },
  ]) assert.equal(compile(water), undefined);
});

test("oversized inputs are rejected before reading coordinates and dense crossings have a bounded fallback", () => {
  let coordinateReads = 0;
  const points = Array.from({ length: 4097 }, () => ({ get x() { coordinateReads++; return 0; }, y: 0 }));
  assert.equal(compile({ surfaces: [{ points }], exclusions: [] }), undefined);
  assert.equal(coordinateReads, 0, "input size is checked before polygon preparation");
  const star = Array.from({ length: 301 }, (_, index) => {
    const angle = index * 149 / 301 * Math.PI * 2;
    return { x: Math.cos(angle) * 100, y: Math.sin(angle) * 100 };
  });
  assert.equal(compile({ surfaces: [{ points: star }], exclusions: [] }), undefined,
    "an arrangement requiring too many intersection cuts keeps the legacy vector mask");
});

test("the actual authored forest compiles once into closed boundaries with unchanged point coverage", async () => {
  const world = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
  const result = compare(world.water, grid(500, 700, 760, 560, 48));
  assert.equal(result.sourceEdges, 1577);
  assert.equal(result.rings.length, 43);
  assert.ok(result.rings.every(ring => ring.length >= 3));
});

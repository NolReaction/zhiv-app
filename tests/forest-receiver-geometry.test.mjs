import assert from "node:assert/strict";
import test from "node:test";
import { validateForestReceiverHoles } from "../features/world/environment/lighting/forest-receiver-geometry.mjs";
const square = (x, y, size) => [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }];
const outer = square(0, 0, 100);

test("receiver exclusions accept independent winding, several disjoint holes and optional empty legacy data", () => {
  for (const holes of [undefined, [], [square(5, 5, 20)], [square(5, 5, 20).reverse(), square(30, 40, 15)]])
    assert.equal(validateForestReceiverHoles(outer, holes), null);
  assert.equal(validateForestReceiverHoles([...outer].reverse(), [square(5, 5, 20)]), null);
});

test("receiver exclusions reject bounded malformed, degenerate and intersecting contours", () => {
  const cases = [null, {}, [null], [[]], [[{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }]],
    [[{ x: 1, y: 1 }, { x: 40, y: 35 }, { x: 1, y: 35 }, { x: 20, y: 1 }]],
    [square(10, 10, 10).map(point => ({ ...point, extra: true }))], [square(10, 10, 10).map(point => ({ ...point, x: NaN }))],
    [square(10, 10, 10).concat({ x: 10, y: 10 })], Array.from({ length: 17 }, () => square(10, 10, 10)),
    [Array.from({ length: 65 }, (_, index) => ({ x: 30 + Math.cos(index / 65 * Math.PI * 2) * 10, y: 30 + Math.sin(index / 65 * Math.PI * 2) * 10 }))]];
  for (const holes of cases) assert.equal(typeof validateForestReceiverHoles(outer, holes), "string");
});

test("receiver exclusions reject boundary contact, escape, mutual contact, overlap and nested holes", () => {
  const cases = [[square(0, 5, 10)], [square(95, 95, 10)], [square(10, 10, 30), square(40, 10, 5)],
    [square(10, 10, 30), square(20, 20, 30)], [square(10, 10, 30), square(20, 20, 5)]];
  for (const holes of cases) assert.equal(typeof validateForestReceiverHoles(outer, holes), "string");
});

test("all vertices inside a concave outer is insufficient when an exclusion edge crosses its notch", () => {
  const concave = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 60, y: 100 },
    { x: 60, y: 30 }, { x: 40, y: 30 }, { x: 40, y: 100 }, { x: 0, y: 100 }];
  const bridge = [{ x: 20, y: 70 }, { x: 80, y: 70 }, { x: 80, y: 80 }, { x: 20, y: 80 }];
  assert.match(validateForestReceiverHoles(concave, [bridge]), /строго внутри/);
});

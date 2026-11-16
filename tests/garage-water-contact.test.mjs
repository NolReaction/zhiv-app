import assert from "node:assert/strict";
import test from "node:test";
import { garageWaterContactFrame } from "../features/world/dev/boat-garage/garage-water-contact.mjs";
import { garageWaterHeight } from "../features/world/dev/boat-garage/garage-water-motion.mjs";

test("immersion surface samples the same world waves as buoyancy, including outside the nominal support beam", () => {
  const center = { x: 835.5, y: 620.2 }, frame = garageWaterContactFrame(center, 700, 2.7, 7, 1141, 1671);
  assert.ok(frame.left <= 0 && frame.right >= 1671, "small buoyancy beams must not leave the motor and bow dry");
  for (const point of frame.points) assert.equal(point.y, center.y + garageWaterHeight(point.x, 2.7, 7));
  assert.ok(frame.submerged.startsWith(frame.surface));
  assert.ok(frame.submerged.endsWith("Z"), "the tint clips a filled underwater region rather than a detached ellipse");
  assert.notEqual(frame.surface, garageWaterContactFrame(center, 700, 5.7, 7, 1141, 1671).surface);
});

test("zero-amplitude authored scenes keep a flat exact waterline while decorative strips stay bounded", () => {
  const frame = garageWaterContactFrame({ x: 700, y: 580 }, 850, 198.4, 0, 1000, 1671);
  assert.ok(frame.points.every(point => point.y === 580));
  assert.ok(frame.wavelets.every(wave => wave.opacity >= 0 && wave.opacity <= .24));
  assert.equal(frame.reflections.length, 8);
  assert.ok(frame.reflections.every(strip => Math.abs(strip.x) <= 4 && strip.height < 5 && strip.opacity > 0 && strip.opacity < .2));
});

test("contact presentation geometry does not mutate author data and sanitises nonfinite presentation clocks", () => {
  const center = { x: 835.5, y: 620.2 }, before = structuredClone(center);
  assert.deepEqual(garageWaterContactFrame(center, 1000, Infinity), garageWaterContactFrame(center, 1000, 0));
  const frame = garageWaterContactFrame(center, NaN, -100, Infinity, NaN, NaN);
  assert.ok(frame.points.every(point => Number.isFinite(point.x + point.y)));
  assert.doesNotMatch(frame.surface + frame.submerged, /NaN|Infinity/);
  assert.deepEqual(center, before);
});

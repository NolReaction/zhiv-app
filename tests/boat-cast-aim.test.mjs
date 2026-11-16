import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BOAT_CAST_CYCLE_MS, BOAT_CAST_GREEN_RADIUS, boatCastAim } from "../features/economy/domain/boat-cast-aim.ts";

test("the release sample matches shared Kotlin/TypeScript vectors for distance, green edges and quality", () => {
  const cases = JSON.parse(readFileSync(new URL("../apps/api/src/test/resources/world/boat-cast-aim-vectors.json", import.meta.url)));
  for (const { voyageId, cast, heldMs, ...expected } of cases) {
    assert.deepEqual(boatCastAim(voyageId, cast, heldMs), expected);
  }
});

test("every sweep can reach green, can miss, and repeats without freezing on long holds", () => {
  for (let cast = 1; cast <= 11; cast++) {
    const targets = new Set();
    let best = 0, worst = 100;
    for (let t = 0; t <= 2000; t += 8) {
      const aim = boatCastAim("voyage-with-a-full-hold", cast, t);
      assert.deepEqual(aim, boatCastAim("voyage-with-a-full-hold", cast, t + BOAT_CAST_CYCLE_MS));
      assert.equal(aim.quality >= 84, Math.abs(aim.target - aim.marker) <= BOAT_CAST_GREEN_RADIUS);
      targets.add(aim.target);
      best = Math.max(best, aim.quality);
      worst = Math.min(worst, aim.quality);
    }
    assert.ok(best >= 98);
    assert.equal(worst, 0);
    assert.ok(targets.size > 10);
  }
});

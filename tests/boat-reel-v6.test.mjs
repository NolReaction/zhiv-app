import assert from "node:assert/strict";
import test from "node:test";
import { boatReelZoneWidth, boatResistanceForClass, initialBoatReel, replayBoatReel, stepBoatReel } from "../features/economy/domain/boat-reel.ts";

test("a legendary catch has the same 100 targets for starter and upgraded controls sampled every 250 ms", () => {
  function landed(motorResponse, hullDamping) {
    let catches = 0;
    for (let index = 1; index <= 100; index++) {
      const seed = Math.imul(index, 0x9e3779b9) >>> 0;
      const challenge = {
        rulesVersion: 6, maxTicks: 600, tickMs: 50, seed, difficulty: 5, fishRarity: "legendary",
        resistance: boatResistanceForClass("legendary", seed), motorResponse, hullDamping,
        zoneWidth: boatReelZoneWidth(3200, "legendary", motorResponse, hullDamping),
      };
      let frame = initialBoatReel(challenge), held = false;
      const inputs = [];
      while (frame.status === "active") {
        if (frame.tick % 5 === 0) {
          const next = frame.fish > frame.bar + frame.velocity * 4;
          if (next !== held) inputs.push({ tick: frame.tick, held: next });
          held = next;
        }
        frame = stepBoatReel(challenge, frame, held);
      }
      assert.deepEqual(replayBoatReel(challenge, inputs, frame.tick), frame);
      if (frame.status === "caught") catches++;
    }
    return catches;
  }
  assert.equal(landed(0, 0), 1);
  assert.equal(landed(5, 20), 86);
  for (const onlyOneModule of [landed(5, 0), landed(0, 20)]) {
    assert.ok(onlyOneModule > 1 && onlyOneModule < 86);
  }
});

test("both modules widen rare-fish tolerances, the landing net keeps its bonus, and common fish keep the full zone", () => {
  for (const rarity of ["common", "uncommon", "rare", "epic", "legendary"]) {
    for (const motor of [0, 1, 2, 3, 4, 5]) for (const hull of [0, 5, 10, 15, 20]) {
      const width = boatReelZoneWidth(3200, rarity, motor, hull);
      const net = boatReelZoneWidth(4000, rarity, motor, hull);
      assert.equal(width % 2, 0);
      assert.equal(net % 2, 0);
      assert.ok(Math.abs(net - width * 1.25) < 2);
      if (rarity === "common") assert.equal(width, 3200);
      else {
        if (motor > 0) assert.ok(width > boatReelZoneWidth(3200, rarity, motor - 1, hull));
        if (hull > 0) assert.ok(width > boatReelZoneWidth(3200, rarity, motor, hull - 5));
      }
    }
  }
});

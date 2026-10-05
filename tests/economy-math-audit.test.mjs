import assert from "node:assert/strict";
import test from "node:test";
import { readEconomyCatalog } from "../scripts/audit-economy-progression.mjs";
import { economicMath, auditEconomicMath } from "../scripts/lib/economy-math.mjs";

const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test("elementary materials retain recursive occupied-slot minutes without treating parallel slots as a wall clock", () => {
  const math = economicMath(readEconomyCatalog());
  assert.deepEqual(math.profile("planks").slotMinutes, { workshop: 15, woodlot: 8 });
  near(math.profile("rope").totalSlotMinutes, 17.5);
  const brick = math.profile("bricks");
  near(brick.slotMinutes.kiln, 30); near(brick.slotMinutes.quarry, 8.4375); near(brick.slotMinutes.woodlot, 4);
  near(math.profile("tools").totalSlotMinutes, 282.5);
  near(math.profile("reinforced_parts").totalSlotMinutes, 450);
  assert.equal(math.profile("fiber").sourceHome, 1, "Forest output exists before the dedicated fiber station");
  assert.equal(math.profile("fiber").referenceHome, 2);
  const berry = math.profile("berries");
  near(berry.slotMinutes.garden, (1800 + 8) / 60 / 10);
  near(berry.slotMinutes.mochlik, 8 / 60 / 10);
  const catalog = readEconomyCatalog();
  const dry = math.batch(catalog.recipes.find(r => r.id === "dry_berries"));
  assert.equal(dry.directHome, 1); assert.equal(dry.referenceHome, 2);
});

test("a joint long order is costed once and exposes its output portfolio rather than charging the entire recipe per product", () => {
  const c = readEconomyCatalog(), math = economicMath(c);
  const batch = math.batch(c.recipes.find(r => r.id === "workshop_structures"));
  assert.deepEqual(batch.output, { beams: 2, cut_stone: 2, metal_parts: 2 });
  near(batch.slotMinutes.workshop, 500); near(batch.elementaryOutputMinutes.workshop, 290);
  for (const id of ["woodlot", "quarry", "kiln"]) near(batch.slotMinutes[id], batch.elementaryOutputMinutes[id]);
  assert.equal(batch.coins, 0);
  const cycle = structuredClone(c); cycle.recipes.find(r => r.id === "make_planks").cost.items.planks = 1;
  assert.throws(() => economicMath(cycle).profile("planks"), /Production cycle/);
});

test("catch expectation changes exactly one fish and keeps bait spending distinct from its fractional species portfolio", () => {
  const math = economicMath(readEconomyCatalog()), initial = math.catchPortfolio();
  near(Object.values(initial.output).reduce((a, b) => a + b, 0), 4);
  near(initial.output.fish, 3.55); near(initial.expectedFishRevenue, 35.12);
  near(math.catchPortfolio("river_rod").expectedFishRevenue - initial.expectedFishRevenue, 1.38);
  const bait = math.catchPortfolio("reed_rod", "crumb_bait");
  assert(bait.expectedFishRevenue - initial.expectedFishRevenue < bait.baitPurchaseCoins);
  assert.equal(math.sourceHome("charcoal"), 2); assert.equal(math.sourceHome("resin"), 3); assert.equal(math.sourceHome("tools"), 4);
  assert.equal(auditEconomicMath(readEconomyCatalog()).profiles.length, 29);
  const chargedRoute = readEconomyCatalog();
  chargedRoute.explorations.find(r => r.id === "shore").cost = { coins: 7, items: { wood: 2 } };
  const charged = economicMath(chargedRoute).profile("fish");
  near(charged.coins, 7 / 3.55); near(charged.slotMinutes.woodlot, 8 / 3.55);
});

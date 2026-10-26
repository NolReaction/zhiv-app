import assert from "node:assert/strict";
import test from "node:test";
import { auditTimeEconomy } from "../scripts/audit-time-economy.mjs";
import { readEconomyCatalog } from "../scripts/audit-economy-progression.mjs";

const report = auditTimeEconomy(readEconomyCatalog());

test("independent time audit accounts for a complete berry package without actor aliases or duplicated inputs", () => {
  const packed = report.items.find(item => item.itemId === "packed_berries");
  assert.equal(packed.value, 420);
  assert.equal(packed.workSeconds, 42 * 60);
  assert.equal(packed.starts, 13);
  assert.deepEqual(packed.stationSeconds, { dryer: 1200, garden: 360, kiln: 420, woodlot: 180, miner: 360 });
  assert.equal(Object.values(packed.stationSeconds).reduce((sum, value) => sum + value, 0), packed.workSeconds);
  assert.equal(packed.stationSeconds.quarry, undefined, "one miner timer cannot count again under its building alias");
  assert.deepEqual(packed.externalItems, {});
  assert(packed.recipeUses.length + packed.ordinaryUses.length + packed.weeklyUses.length > 0);
});

test("each chapter separates earned project payouts, fees and one-versus-three-slot capacity bounds", () => {
  assert.equal(report.chapters.length, 4);
  for (const chapter of report.chapters) {
    assert.equal(chapter.buildingFeesMinusProjectRewards, chapter.constructionCoins - chapter.projectCoins);
    assert.equal(chapter.productionStarts, Object.values(chapter.sourceStarts).reduce((sum, count) => sum + count, 0));
    assert(chapter.productionCapacityLowerBoundSeconds.threeSlots <= chapter.productionCapacityLowerBoundSeconds.oneSlot);
    assert(chapter.productionCapacityLowerBoundSeconds.threeSlots >= (chapter.stationSeconds.miner ?? 0));
  }
  assert.deepEqual(report.chapters.map(chapter => chapter.constructionCoins), [400, 3050, 22100, 61200]);
  assert.deepEqual(report.chapters.map(chapter => chapter.projectCoins), [325, 1457, 15689, 21152]);
  assert.equal(report.chapters[3].buildingFeesMinusProjectRewards, 40048, "the late chapter requires earned coins beyond its project proceeds");
  assert(report.assumptions.some(text => text.includes("not calendar-playthrough")));
});

test("unknown fish and relic acquisition stay external rather than gaining invented guaranteed work", () => {
  for (const id of ["fish_common", "ancient_core"]) {
    const profile = report.items.find(item => item.itemId === id);
    assert.equal(profile.workSeconds, 0); assert.equal(profile.starts, 0);
    assert.deepEqual(profile.externalItems, { [id]: 1 });
  }
});

test("independent audit catches repeated time pricing, repeated order premium and retired current sources", () => {
  const wrongPrice = readEconomyCatalog();
  wrongPrice.items.find(item => item.id === "packed_berries").baseSellPrice += 60;
  wrongPrice.localBuyer.unitPrices.packed_berries += 60;
  assert.throws(() => auditTimeEconomy(wrongPrice), /packed_berries: price must equal inputs plus its own reference time/);
  const wrongOrder = readEconomyCatalog();
  wrongOrder.food.orders.templates.find(order => order.id === "builder_trail_snack").coins += 150;
  assert.throws(() => auditTimeEconomy(wrongOrder), /builder_trail_snack: order must pay full item value plus its declared premium once/);
  const retired = readEconomyCatalog();
  retired.timeEconomy.baselineExplorations.stone = "quarry_stone_overnight";
  assert.throws(() => auditTimeEconomy(retired), /stone: retired source cannot establish a current price/);
});

test("current unit sources and advertised unlocks cannot silently return to bulk jobs or future-home materials", () => {
  const batch = readEconomyCatalog();
  batch.recipes.find(recipe => recipe.id === "dry_berries").maxBatch = 2;
  assert.throws(() => auditTimeEconomy(batch), /dry_berries: bulk production cannot be restarted/);
  const future = readEconomyCatalog();
  future.buildings.find(building => building.id === "lighthouse").levels[0].cost.items.lens = 1;
  assert.throws(() => auditTimeEconomy(future), /lighthouse:1: materials or prerequisites unavailable at advertised home 3: lens/);
});


test("hero material baskets cannot regain a hidden mint or a long unattended timer", () => {
  const mint = readEconomyCatalog();
  mint.explorations.find(source => source.id === "forest").rewards.wood += 1;
  assert.throws(() => auditTimeEconomy(mint), /forest: hero material trip must earn only its own time value after inputs/);
  const overnight = readEconomyCatalog();
  overnight.explorations.find(source => source.id === "forest").seconds = 8 * 3600;
  assert.throws(() => auditTimeEconomy(overnight), /forest: material exploration must take at most one hour/);
});

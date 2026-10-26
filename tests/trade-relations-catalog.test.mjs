import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { auditTradeRelations } from "../scripts/audit-trade-relations.mjs";
import { reputationXpForEffort, tradeOrderEffort } from "../scripts/lib/trade-relations-effort.mjs";

const catalog = () => JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url), "utf8"));
const report = auditTradeRelations(catalog());
const vectors = JSON.parse(readFileSync(new URL("../apps/api/src/test/resources/world/trade-relations-vectors.json", import.meta.url), "utf8"));

test("the shared TS and Kotlin reference vectors cover every authored request and paid weekly stage", () => {
  const clean = row => Object.fromEntries(Object.entries(row).filter(([key]) => !["completeNpcPurchaseCoins", "immediateNpcProfitCoins"].includes(key)));
  assert.deepEqual(vectors.orders, report.orders.map(clean));
  assert.deepEqual(vectors.weekly, report.weekly.map(weekly => ({ ...weekly, stages: weekly.stages.map(clean) })));
  const config = catalog().tradeRelations;
  for (const expected of vectors.ranks) {
    const index = config.ranks.findLastIndex(rank => rank.requiredXp <= expected.xp);
    assert.equal(index, expected.rankIndex);
    assert.equal(config.ranks[index].bonusBps, expected.bonusBps);
  }
});

test("all five residents have bounded useful reputation with complete ordinary and weekly sources", () => {
  assert.equal(report.baselineOrders, 85);
  assert.equal(report.orders.length, 163);
  assert.equal(report.weekly.length, 13);
  assert.equal(report.weekly.flatMap(order => order.stages).length, 39);
  assert.equal(report.pacing.finalXp, 1600);
  assert(report.pacing.optimisticEarliestElapsedDays >= 4);
  assert.equal(report.pacing.maximumDailyOrdinaryXp, 180);
  assert.equal(report.pacing.maximumDailyPurchaseXp, 2);
  const samples = report.pacing.residents.flatMap(resident => resident.scenarios);
  assert(samples.every(sample => sample.approximateWeeksToMaximum >= 1 && sample.approximateWeeksToMaximum <= 5));
});

test("total work includes drying ingredients and basic acquisition without counting miner occupancy twice", () => {
  const c = catalog(), effort = tradeOrderEffort(c);
  const snack = effort(c.food.orders.templates.find(order => order.id === "builder_trail_snack"));
  assert.equal(snack.manufacturingSeconds, 15 * 60);
  assert.equal(snack.effortSeconds, 2148);
  assert.equal(snack.reputationXp, 14);
  assert.equal(snack.fishingUncertain, false);
  const ore = effort({ id: "ore_clock", requiredHomeLevel: 3, requiredBuildings: { quarry: 2 }, items: { ore: 2 } });
  assert.equal(ore.effortSeconds, 2 * 600, "two ten-minute mining jobs count once each, not once per actor and station");
  assert.equal(ore.references.ore, "quarry_ore");
  assert.equal(ore.manufacturingSeconds, 0);
});

test("authored effort cannot use an inaccessible later shortcut or depend on JSON source order", () => {
  const c = catalog(), changed = catalog();
  for (const recipe of changed.recipes.filter(recipe => ["smelt_tempered_iron", "make_clear_glass", "make_precision_parts", "hardwood_shift"].includes(recipe.id))) recipe.seconds = 1;
  changed.recipes.reverse(); changed.explorations.reverse();
  const before = tradeOrderEffort(c), after = tradeOrderEffort(changed);
  for (const template of c.food.orders.templates) {
    const actual = after(template), expected = before(template);
    for (const key of ["effortSeconds", "manufacturingSeconds", "fishingUncertain", "reputationXp"]) assert.equal(actual[key], expected[key], `${template.id}:${key}`);
  }
});

test("a cyclic expedition alternative cannot hide valid basic ingredient acquisition", () => {
  const c = catalog(), template = c.food.orders.templates.find(order => order.id === "builder_survey_camp");
  const actual = tradeOrderEffort(c)(template);
  assert.equal(actual.effortSeconds, 14436);
  assert.equal(actual.manufacturingSeconds, 10200);
  assert.equal(actual.fishingUncertain, true);
  assert.equal(actual.references.wood, "gather_wood");
});

test("reputation scales with work while every ordinary award remains small", () => {
  assert.deepEqual([60, 300, 3600, 43200].map(seconds => reputationXpForEffort(seconds)), [10, 10, 16, 60]);
  assert.equal(reputationXpForEffort(60 * 2 ** 30), 60);
  assert.throws(() => reputationXpForEffort(0), /positive whole seconds/);
  assert.throws(() => reputationXpForEffort(.5), /positive whole seconds/);
  assert(new Set(report.orders.map(order => order.reputationXp)).size >= 5);
  assert(report.orders.every(order => order.reputationXp >= 8 && order.reputationXp <= 60));
});

test("every fully purchasable ordinary or weekly basket remains unprofitable at maximum loyalty", () => {
  const ordinary = report.orders.filter(order => order.completeNpcPurchaseCoins !== null);
  const weekly = report.weekly.flatMap(order => order.stages).filter(stage => stage.completeNpcPurchaseCoins !== null);
  assert.equal(ordinary.length, 21);
  assert.equal(weekly.length, 5);
  assert([...ordinary, ...weekly].every(order => order.immediateNpcProfitCoins < 0));
  assert(report.merchantDiscounts.every(row => row.discountedPrice >= row.resalePrice));
  const c = catalog();
  c.localBuyer.unitPrices[c.fishing.baits[0].itemId] = 2;
  assert.throws(() => auditTradeRelations(c), /maximum loyalty discount creates immediate resale profit/);
});

test("unavailable upstream processing and inflated future reputation are rejected", () => {
  const c = catalog();
  const newRequest = c.food.orders.templates.find(order => order.id === "kamneshmyg_survey_lenses");
  newRequest.requiredBuildings.kiln = 2;
  assert.throws(() => auditTradeRelations(c), /unavailable source chain for glass/);
  const inflated = catalog(); inflated.food.orders.templates[0].reputationXp = 999;
  assert.throws(() => auditTradeRelations(inflated), /incorrect reputation reward/);
  const fast = catalog(); fast.tradeRelations.ranks.at(-1).requiredXp = 500;
  assert.throws(() => auditTradeRelations(fast));
});

test("optional weekly deadlines exclude legendary catches and remain three individually paid stages", () => {
  for (const weekly of report.weekly) {
    assert.equal(weekly.stages.length, 3);
    assert(weekly.stages.every(stage => stage.coins > 0 && stage.reputationXp > 0));
    assert(weekly.reputationXp >= 120 && weekly.reputationXp <= 600);
    assert.equal(weekly.coins, weekly.stages.reduce((sum, stage) => sum + stage.coins, 0));
    assert.equal(weekly.effortSeconds, weekly.stages.reduce((sum, stage) => sum + stage.effortSeconds, 0));
    assert(weekly.stages.every(stage => !Object.keys(stage.items).some(id => ["fish_rare", "fish_epic", "fish_legendary"].includes(id))));
  }
});


test("early materials use an obtainable alternative until their canonical station exists", () => {
  const c = catalog(), effort = tradeOrderEffort(c);
  const early = effort({ id: "early_stone", requiredHomeLevel: 1, requiredBuildings: {}, items: { stone: 1 } });
  const unbuilt = effort({ id: "unbuilt_quarry", requiredHomeLevel: 2, requiredBuildings: {}, items: { stone: 1 } });
  const built = effort({ id: "built_quarry", requiredHomeLevel: 2, requiredBuildings: { quarry: 1 }, items: { stone: 1 } });
  assert.equal(early.references.stone, "forest");
  assert.equal(unbuilt.references.stone, "forest");
  assert.equal(built.references.stone, "quarry_stone");
  assert.equal(built.effortSeconds, 180);
  assert(early.effortSeconds > built.effortSeconds);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readEconomyCatalog } from "../scripts/audit-economy-progression.mjs";
import { auditFoodUtility } from "../scripts/audit-food-utility.mjs";

const catalog = readEconomyCatalog(), report = auditFoodUtility(catalog);
const meal = id => report.meals.find(meal => meal.itemId === id);

test("a small portion remains cheap for short building work without scaling to the whole late timer", () => {
  const fish = meal("grilled_fish"), feast = meal("epic_fish");
  assert.equal(fish.opportunityCoins, 45);
  assert.equal(fish.construction[0].savedSeconds, 163);
  assert.equal(fish.construction.at(-1).savedSeconds, 163);
  assert.equal(feast.construction[3].savedSeconds, 5929);
  assert(feast.construction[3].coinsPerSavedMinute < fish.construction[3].coinsPerSavedMinute);
  const unlimited = structuredClone(catalog);
  unlimited.food.meals.find(meal => meal.itemId === "grilled_fish").builderWorkSeconds = 21600;
  assert.throws(() => auditFoodUtility(unlimited), /starter food cannot cover/);
});

test("food keeps distinct speed, work-budget and access choices instead of one universal optimum", () => {
  assert.equal(report.meals.length, catalog.food.meals.length);
  assert(meal("grilled_fish").opportunityCoins < meal("berry_fish").opportunityCoins);
  assert(meal("berry_fish").heroSpeedBps > meal("grilled_fish").heroSpeedBps);
  assert(meal("strawberry_compote").builderSpeedBps > meal("strawberry_compote").heroSpeedBps);
  assert(meal("legendary_fish").heroSpeedBps > meal("festive_sturgeon").heroSpeedBps);
  assert(meal("festive_sturgeon").heroWorkSeconds > meal("legendary_fish").heroWorkSeconds);
  assert(Array.isArray(report.dominated), "local Pareto findings must remain inspectable, not silently removed");
});

test("experiment portion cost accounts for lost ingredients and still supplies a real work reserve", () => {
  const glazed = meal("currant_glazed_fish");
  assert.equal(glazed.ingredientCoins, 585);
  assert.equal(glazed.opportunityCoins, 924);
  assert.equal(glazed.expectedAttempts, 1 / .85);
  assert(glazed.heroSavedSeconds > meal("currant_jelly").heroSavedSeconds);
});

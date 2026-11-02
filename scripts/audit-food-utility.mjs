import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { economicMath } from "./lib/economy-math.mjs";

const rounded = value => Number(value.toFixed(6));
const savedSeconds = (seconds, speedBps, budget) => {
  const used = Math.min(seconds, budget);
  return used - Math.ceil(used * 10000 / (10000 + speedBps));
};

/** Opportunity value includes the complete ingredient chain and own cooking.
 * This compares paid portions, not fabricated deadlines for random fish. */
export function auditFoodUtility(catalog) {
  const math = economicMath(catalog), jobs = [1800, 3600, 7200, 14400, 21600];
  const meals = catalog.food.meals.map(meal => {
    const recipe = catalog.recipes.find(recipe => recipe.rewards[meal.itemId]);
    const item = catalog.items.find(item => item.id === meal.itemId);
    const profile = math.profile(meal.itemId);
    assert(Number.isSafeInteger(meal.builderWorkSeconds) && meal.builderWorkSeconds > 0 && meal.builderWorkSeconds <= 21600,
      `${meal.itemId}: new builder portions need a bounded work budget`);
    assert(meal.heroWorkSeconds > 0 && meal.heroSpeedBps > 0 && meal.builderSpeedBps > 0);
    const heroSaved = savedSeconds(meal.heroWorkSeconds, meal.heroSpeedBps, meal.heroWorkSeconds);
    return { itemId: meal.itemId, recipeId: recipe.id, requiredHomeLevel: profile.referenceHome,
      opportunityCoins: item.baseSellPrice, ingredientCoins: Object.entries(recipe.cost.items).reduce((sum, [id, count]) =>
        sum + catalog.items.find(item => item.id === id).baseSellPrice * count, recipe.cost.coins),
      cookingSeconds: recipe.seconds, expectedAttempts: 10000 / (recipe.experiment?.successBps ?? 10000),
      heroSpeedBps: meal.heroSpeedBps, heroWorkSeconds: meal.heroWorkSeconds,
      heroSavedSeconds: heroSaved, heroCoinsPerSavedMinute: rounded(item.baseSellPrice / (heroSaved / 60)),
      builderSpeedBps: meal.builderSpeedBps, builderWorkSeconds: meal.builderWorkSeconds,
      construction: jobs.map(seconds => { const saved = savedSeconds(seconds, meal.builderSpeedBps, meal.builderWorkSeconds);
        return { baseSeconds: seconds, savedSeconds: saved, durationSeconds: seconds - saved,
          coinsPerSavedMinute: saved ? rounded(item.baseSellPrice / (saved / 60)) : null }; }) };
  });
  const dominates = (first, second) => first.requiredHomeLevel <= second.requiredHomeLevel
    && first.opportunityCoins <= second.opportunityCoins && first.heroSpeedBps >= second.heroSpeedBps
    && first.heroSavedSeconds >= second.heroSavedSeconds
    && first.construction.every((row, index) => row.savedSeconds >= second.construction[index].savedSeconds)
    && (first.opportunityCoins < second.opportunityCoins || first.heroSpeedBps > second.heroSpeedBps
      || first.heroSavedSeconds > second.heroSavedSeconds
      || first.construction.some((row, index) => row.savedSeconds > second.construction[index].savedSeconds));
  const dominated = meals.flatMap(meal => meals.filter(other => other !== meal && dominates(other, meal))
    .map(other => ({ itemId: meal.itemId, dominatedBy: other.itemId })));
  const universal = meals.filter(meal => meals.every(other => other === meal || dominates(meal, other)));
  assert.equal(universal.length, 0, "one meal must not dominate every hero and builder choice");
  const starter = meals.find(meal => meal.itemId === "grilled_fish");
  assert(starter.builderWorkSeconds <= 3600, "starter food cannot cover an entire late construction");
  assert(meals.some(meal => meal.construction.at(-1).savedSeconds > starter.construction.at(-1).savedSeconds * 10),
    "advanced food must give a material time advantage on long construction");
  return { catalogVersion: catalog.version, meals, dominated,
    assumptions: ["One builder portion accelerates only its nominal work budget in one construction; unused budget is not carried over",
      "Hero food preserves unused baseline work across trips; no idle-time decay",
      "No other buffs or skill speed; equal external speed scales saved time down without changing the ordering",
      "Price is complete production opportunity value, including failed experiment attempts, not shop markup",
      "Pareto comparison covers coin value, full hero use and 30/60/120/240/360-minute construction; species acquisition, recipe practice, cooking slots and stock scarcity can change the choice",
      "Dominance findings are reported rather than claiming every recipe has equal efficiency or must be cooked"] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const catalog = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url)));
  process.stdout.write(`${JSON.stringify(auditFoodUtility(catalog), null, 2)}\n`);
}

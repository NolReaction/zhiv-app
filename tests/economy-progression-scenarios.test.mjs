import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadProgressionRules, simulateProgression, summarizeProgression } from "../scripts/simulate-economy-progression.mjs";

const loaded = await loadProgressionRules();
after(() => loaded.close());
const sum = object => Object.values(object).reduce((total, count) => total + count, 0);

function validateJourney(result) {
  const report = summarizeProgression(result); // Verifies every item and both currency ledgers.
  assert(result.completed, `Home finale remains reachable; last wait ${JSON.stringify(result.waits.at(-1))}`);
  assert.equal(result.state.buildings.home, Math.max(...loaded.catalog.buildings.find(row => row.id === "home").levels.map(row => row.level)));
  assert(result.slotPurchases.some(row => row.slots === 2));
  assert(result.slotPurchases.some(row => row.slots === 3), "The test actually exercises third slots, rather than merely mentioning them");
  assert.equal(sum(result.pearlLedger.debits), result.slotPurchases.reduce((total, row) => total + row.paid, 0));
  const daily = result.rewardClaims.filter(row => row.kind === "daily");
  assert.equal(daily.length, 7);
  assert.equal(new Set(result.rewardClaims.map(row => row.id)).size, result.rewardClaims.length);
  for (let index = 1; index < daily.length; index++) {
    assert(Date.parse(daily[index].at) - Date.parse(daily[index - 1].at) >= 20 * 3_600_000);
    assert(daily[index].at.slice(0, 10) > daily[index - 1].at.slice(0, 10));
  }
  assert.equal(result.rewardClaims.filter(row => row.id === "onboarding").length, 1);
  assert.equal(result.rewardClaims.filter(row => row.id === "welcome").length, 1);
  assert(!result.rewardClaims.some(row => row.id.startsWith("achievement:first_sale")), "NPC sales do not invent confirmed player-market sales");
  assert(!result.rewardClaims.some(row => ["five_friends", "seven_day_streak", "thousand_taps", "linked_email"].some(id => row.id.includes(id))));
  for (const purchase of result.slotPurchases) {
    const offer = loaded.catalog.productionSlots.upgrades.find(row => row.slots === purchase.slots);
    assert.equal(purchase.paid, offer.pricePearls);
    assert(purchase.home >= offer.requiredHomeLevel);
  }
  assert(report.manualHours > 0 && report.manualHours < report.activeHours);
  assert.equal(report.manualHours, report.commandCount * report.manualSeconds / 3600);
  return report;
}

test("fresh progression earns real gifts and second/third slots while preserving wallet and item conservation", t => {
  const result = simulateProgression(loaded, { regularActiveMinutes: 20, firstVisitMinutes: 60, seed: 1, maxDays: 120 });
  const report = validateJourney(result);
  assert.equal(result.pearlLedger.initial, 0);
  assert.equal(result.pearlLedger.credits.externalSlotBudget, undefined);
  // This is a broad regressions bound, not a promise that every player takes a month.
  assert(report.home5Days >= 20 && report.home5Days <= 100);
  t.diagnostic(JSON.stringify({ home5Days: report.home5Days, manualHours: report.manualHours, visitHours: report.activeHours,
    commands: report.commandCount, purchasedSlots: report.slotPurchases.length, coinLedger: report.coinLedger, pearlLedger: report.pearlLedger }));
});

test("all-slot stress case declares external pearls and still pays every authored slot price", t => {
  const result = simulateProgression(loaded, { regularActiveMinutes: 20, firstVisitMinutes: 60, seed: 7, externalSlotBudget: 3500, maxDays: 120 });
  const report = validateJourney(result);
  assert.equal(result.pearlLedger.credits.externalSlotBudget, 3500);
  assert.equal(result.slotPurchases.length, 10);
  assert.equal(sum(result.pearlLedger.debits), 3500);
  assert.deepEqual(Object.values(result.state.productionSlots).sort(), [3, 3, 3, 3, 3]);
  assert(report.home5Days >= 15 && report.home5Days <= 100);
  t.diagnostic(JSON.stringify({ home5Days: report.home5Days, commands: report.commandCount, paidSlots: report.slotPurchases.length }));
});

test("seeded short scenarios replay exactly and never act after a visit ends", () => {
  const options = { regularActiveMinutes: 15, firstVisitMinutes: 45, seed: 42, maxDays: 3, manualSeconds: 4 };
  const first = simulateProgression(loaded, options), second = simulateProgression(loaded, options);
  assert.deepEqual(summarizeProgression(first), summarizeProgression(second));
  assert(first.rewardClaims.length > 0 && first.actions.start_production > 0);
  assert(first.activeSeconds <= (45 + (first.visitCount - 1) * 15) * 60);
  assert(first.revision * 4 <= first.activeSeconds);
});

test("a long daily session has a real nonoverlapping schedule and attention budget", () => {
  const result = simulateProgression(loaded, { visitsPerDay: 1, regularActiveMinutes: 960, firstVisitMinutes: 960, maxDays: 2 });
  summarizeProgression(result);
  assert.equal(result.visitCount, 2);
  assert(result.revision > 500, "the old short-visit command ceiling must not truncate an intensive player");
  assert.equal(result.windows[1].begin - result.windows[0].begin, 24 * 3_600_000);
  assert(result.windows.every(window => window.end - window.begin === 16 * 3_600_000));
  assert(result.windows[0].end < result.windows[1].begin);
  assert(result.revision * 2 <= result.activeSeconds);
  assert(result.activeSeconds <= 32 * 3600);
});

test("resident requests and weekly contracts are funded by the same fresh playthrough", () => {
  const result = simulateProgression(loaded, { regularActiveMinutes: 30, socialMode: "balanced", completionGoal: "observation", maxDays: 14 });
  const report = summarizeProgression(result);
  assert.equal(report.social.funded, true);
  assert(report.social.deliveries.some(delivery => !delivery.weekly));
  assert(report.social.deliveries.some(delivery => delivery.weekly));
  assert(report.social.completedWeekly > 0);
  assert(report.social.acceptedWeeklies.every(weekly => Date.parse(weekly.expiresAt) - Date.parse(weekly.acceptedAt) === 7 * 24 * 3_600_000));
  assert(!Object.keys(report.coinLedger.credits).some(key => /fixture|external/.test(key)));
  assert(!Object.keys(report.pearlLedger.credits).some(key => /fixture|external/.test(key)));
  assert(report.social.deliveries.every(delivery => delivery.xp >= 0 && Object.keys(delivery.items).length > 0));
  assert.equal(result.state.tradeRelations.completedWeekly, report.social.completedWeekly);
});

test("paid-capacity stress preserves future slot funds while earned pearls speed up real buildings", () => {
  const result = simulateProgression(loaded, { regularActiveMinutes: 480, firstVisitMinutes: 480, visitsPerDay: 1,
    externalSlotBudget: 3500, speedupPolicy: "earned", maxDays: 30 });
  const report = summarizeProgression(result);
  assert(result.completed, "Instant building completion must unlock its real successor recipes");
  assert(report.home5Days != null && report.home5Days > 0);
  assert(report.speedups.length > 0);
  assert.equal(result.slotPurchases.length, 10, "Reserved external funds still pay all ten slots");
  const earnedPearls = sum(result.pearlLedger.credits) - 3500;
  assert(report.speedups.reduce((total,row) => total + row.paid,0) <= earnedPearls);
  assert.equal(sum(result.pearlLedger.debits), result.slotPurchases.reduce((total,row) => total + row.paid,0)
    + report.speedups.reduce((total,row) => total + row.paid,0));
});

test("a fresh player can fund the fishing gear needed to produce every active recipe", () => {
  const result = simulateProgression(loaded, { regularActiveMinutes: 480, firstVisitMinutes: 480, visitsPerDay: 1,
    completionGoal: "all-recipes", maxDays: 90 });
  const report = summarizeProgression(result);
  assert(result.completed, `Unproduced recipes: ${report.missingRecipes.join(", ")}`);
  assert.equal(report.missingRecipes.length, 0);
  assert.equal(report.recipesCompleted, loaded.catalog.recipes.filter(recipe => !recipe.retired).length);
  assert(report.allRecipesDays >= report.home5Days);
  assert((report.actions.equip_fishing_rod ?? 0) <= (report.actions.start_fishing ?? 0), "A cast follows every useful gear choice instead of endlessly swapping rods");
  assert(report.coinLedger.debits.buy_fishing_item > 0);
});

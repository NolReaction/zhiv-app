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
  const result = simulateProgression(loaded, { regularActiveMinutes: 20, firstVisitMinutes: 60, seed: 1, maxDays: 60 });
  const report = validateJourney(result);
  assert.equal(result.pearlLedger.initial, 0);
  assert.equal(result.pearlLedger.credits.externalSlotBudget, undefined);
  // This is a broad regressions bound, not a promise that every player takes a month.
  assert(report.home5Days >= 20 && report.home5Days <= 50);
  t.diagnostic(JSON.stringify({ home5Days: report.home5Days, manualHours: report.manualHours, visitHours: report.activeHours,
    commands: report.commandCount, purchasedSlots: report.slotPurchases.length, coinLedger: report.coinLedger, pearlLedger: report.pearlLedger }));
});

test("all-slot stress case declares external pearls and still pays every authored slot price", t => {
  const result = simulateProgression(loaded, { regularActiveMinutes: 20, firstVisitMinutes: 60, seed: 7, externalSlotBudget: 3500, maxDays: 60 });
  const report = validateJourney(result);
  assert.equal(result.pearlLedger.credits.externalSlotBudget, 3500);
  assert.equal(result.slotPurchases.length, 10);
  assert.equal(sum(result.pearlLedger.debits), 3500);
  assert.deepEqual(Object.values(result.state.productionSlots).sort(), [3, 3, 3, 3, 3]);
  assert(report.home5Days >= 15 && report.home5Days <= 50);
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

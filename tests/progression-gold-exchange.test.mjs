import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { goldExchangePairs, progressionCases } from "../scripts/audit-progression-scenarios.mjs";
import { loadProgressionRules, selectGoldConversionOffer, simulateProgression, summarizeProgression } from "../scripts/simulate-economy-progression.mjs";

const offers = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/currency-exchange-catalog.json", import.meta.url), "utf8")).offers;
const choose = (deficit, pearls, coins = 0, maximumCoins = 1_000_000) => selectGoldConversionOffer(offers, { deficit, pearls, coins, maximumCoins });

test("conversion spends the least sufficient package, respects wallet capacity and never creates unaffordable funding", () => {
  assert.equal(choose(0, 200), null);
  assert.equal(choose(1, 39), null);
  assert.equal(choose(1, 200).id, offers[0].id);
  assert.equal(choose(1001, 200).id, offers[1].id);
  assert.equal(choose(3000, 200).id, offers[2].id);
  assert.equal(choose(6001, 140).id, offers[1].id);
  assert.equal(choose(1, 200, 999_001), null);
  assert.equal(choose(1, 200, 999_000).id, offers[0].id);
});

test("twelve conversion cases retain identical fresh controls and cannot contaminate the standard family", () => {
  assert.equal(progressionCases.length, 68);
  assert.equal(goldExchangePairs.length, 12);
  assert.equal(new Set(progressionCases.map(row => row.label)).size, progressionCases.length);
  for (const pair of goldExchangePairs) {
    const control = progressionCases.find(row => row.label === pair.control);
    const conversion = progressionCases.find(row => row.label === pair.conversion);
    assert.equal(control.currencyExchangePolicy, undefined);
    assert.equal(conversion.currencyExchangePolicy, "construction-shortfall");
    const actual = { ...conversion };
    const expected = { ...control };
    delete actual.label;
    delete actual.currencyExchangePolicy;
    delete expected.label;
    assert.deepEqual(actual, expected, "Only the currency policy and display ID differ");
    assert.equal(conversion.externalSlotBudget ?? 0, 0);
  }
});

test("fresh conversion play records actual charges, earned funding, timing and both conservation ledgers", async () => {
  const loaded = await loadProgressionRules();
  try {
    const options = { regularActiveMinutes: 30, firstVisitMinutes: 60, maxDays: 3, seed: 7 };
    const control = summarizeProgression(simulateProgression(loaded, options));
    const converted = summarizeProgression(simulateProgression(loaded, { ...options, currencyExchangePolicy: "construction-shortfall" }));
    assert.equal(control.goldConversions.length, 0);
    assert.equal(control.actions.exchange_pearls_for_gold, undefined);
    assert(converted.goldConversions.length > 0, "This fixture actually converts earned pearls");
    assert.equal(converted.actions.exchange_pearls_for_gold, converted.goldConversions.length);
    assert.equal(converted.pearlLedger.credits.externalSlotBudget, undefined);
    for (const row of converted.goldConversions) {
      const offer = offers.find(offer => offer.id === row.offerId);
      assert.equal(row.paidPearls, offer.pearls);
      assert.equal(row.receivedCoins, offer.coins);
      assert(row.deficit > 0 && row.day >= 0 && row.day <= converted.elapsedDays);
    }
    assert.throws(() => simulateProgression(loaded, { ...options, currencyExchangePolicy: "construction-shortfall", externalSlotBudget: 3500 }), /earned pearls/);
    assert.throws(() => simulateProgression(loaded, { ...options, currencyExchangePolicy: "invented" }), /Unknown currency exchange policy/);
  } finally { await loaded.close(); }
});

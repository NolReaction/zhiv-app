import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { auditBoatFishingBalance, auditBoatFishWeights } from "../scripts/audit-boat-fishing.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog: catalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { newBoatState, boatFishWeight, publicBoatState, boatDepartureReason, boatClaimPracticeSeconds } = await vite.ssrLoadModule("/features/economy/domain/boat-fishing.ts");
const { applyBoatCommand } = await vite.ssrLoadModule("/features/economy/domain/boat-commands.ts");
const { fishClassInventory, fishingBaitCompatible } = await vite.ssrLoadModule("/features/economy/domain/fishing.ts");
const { initialBoatReel, stepBoatReel } = await vite.ssrLoadModule("/features/economy/domain/boat-reel.ts");
const epoch = Date.parse("2026-11-02T10:00:00Z");
const uuid = value => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;

// Isolated domain fixture: ownership is supplied, never presented as earned progression.
function state({ upgrades = [], artifacts = [], boosted = false } = {}) {
  return { wallet: { coins: 50000, pearls: 10000 }, inventory: { crumb_bait: 10 },
    buildings: Object.fromEntries(catalog.buildings.map(building => [building.id, building.levels.at(-1).level])), jobs: [],
    fishing: { ownedRods: catalog.fishing.rods.map(rod => rod.id), ownedHooks: catalog.fishing.hooks.map(hook => hook.id),
      equippedRodId: "reed_rod", equippedHookId: "bare_hook", equippedBaitId: "crumb_bait", catches: {}, stock: {} },
    completedExplorations: 0, unlockedItems: [],
    progression: { routes: {}, recipes: {}, skills: { buildingHistoryVersion: 1, fishingSeconds: boosted ? catalog.skills.levels.at(-1).requiredSeconds : 0 } },
    food: boosted ? { heroMeal: "legendary_fish", heroMealEffect: { remainingWorkSeconds: 7200, totalWorkSeconds: 7200, speedBps: 10000 } } : { heroMeal: null },
    tapBoost: boosted ? { charge: 100, powerBps: 5000, grantedAt: new Date(epoch).toISOString() } : undefined,
    boat: { ...newBoatState(), level: 1, upgrades, artifacts } };
}
const services = {
  debit(current, cost) {
    assert(current.wallet.coins >= cost.coins);
    for (const [id, amount] of Object.entries(cost.items)) assert((current.inventory[id] ?? 0) >= amount);
    current.wallet.coins -= cost.coins;
    for (const [id, amount] of Object.entries(cost.items)) current.inventory[id] -= amount;
  },
  credit(current, rewards) {
    for (const [id, amount] of Object.entries(fishClassInventory(rewards))) current.inventory[id] = (current.inventory[id] ?? 0) + amount;
  },
  assertStorage(_before, after) { assert(Object.values(after.inventory).reduce((sum, amount) => sum + amount, 0) <= 750); },
  fail(code, message) { throw Object.assign(new Error(message), { code }); },
};
function driver(current, random = maximum => Math.min(1234, maximum - 1)) {
  let sequence = 0;
  return (action, targetId = current.boat.voyage?.id ?? catalog.boat.routeId, at = epoch, extra = {}) => applyBoatCommand(current,
    { requestId: uuid(++sequence), ownerPublicId: "0000-0000-0001", expectedRevision: 0, action, targetId, quantity: 1, totalPrice: 0, ...extra },
    at, () => uuid(++sequence), random, services);
}
function departure(current, random) { const run = driver(current, random); run("depart_boat"); return run; }
function play(challenge) {
  let reel = initialBoatReel(challenge), held = false;
  const inputs = [];
  while (reel.status === "active") {
    const nextHeld = reel.bar + reel.velocity * 5 < reel.fish;
    if (nextHeld !== held) { held = nextHeld; inputs.push({ tick: reel.tick, held }); }
    reel = stepBoatReel(challenge, reel, held);
  }
  return { status: reel.status, command: { challengeId: challenge.id, inputs, endTick: reel.tick } };
}

test("all legal existing tackle and every boat upgrade combination stay below the same shore income ceiling", () => {
  const report = auditBoatFishingBalance(catalog);
  assert.equal(report.legalLoadouts, 1104);
  assert.equal(report.economicComparisons, 4416);
  assert.deepEqual(report.modes.map(mode => mode.maxFishPerHour), [24, 30, 30, 37.5]);
  assert.equal(report.shore.maxFishPerHour, 40);
  assert(report.modes.every(mode => mode.maximumRatioToSameShoreLoadout < 1));
  assert.equal(report.upgrades.find(upgrade => upgrade.id === "repair").totalForegoneSaleValue, 700);
  assert.equal(report.upgrades.find(upgrade => upgrade.id === "telescope").totalForegoneSaleValue, 2080);
  assert(report.blueprints.every(blueprint => blueprint.awardedByBoat === false && !("guaranteedAtQualifiedVoyage" in blueprint)));
});

test("the audit rejects inflation, missing species, unreachable materials and duplicate blueprint milestones", () => {
  for (const mutate of [copy => { copy.boat.maxCasts = 8; }, copy => { copy.boat.oarsTravelSeconds = 60; },
    copy => { delete copy.boat.weights.fish; }, copy => { copy.boat.blueprints[0].milestones = [1, 1, 3]; },
    copy => { copy.boat.upgrades.find(upgrade => upgrade.id === "repair").cost.items.lens = 1; }]) {
    const changed = structuredClone(catalog); mutate(changed);
    assert.throws(() => auditBoatFishingBalance(changed));
  }
});

test("runtime mass has an independently measured rare tail for every species instead of a uniform weight roll", () => {
  const report = auditBoatFishWeights(catalog, boatFishWeight);
  assert.equal(report.length, catalog.fishing.fish.length);
  for (const row of report) {
    assert(row.meanPositionInRange > .247 && row.meanPositionInRange < .253);
    assert(row.probabilityUpperTenth > .003 && row.probabilityUpperTenth < .007);
    assert.equal(boatFishWeight(row.minGrams, row.maxGrams, 10000, 10000), row.maxGrams);
  }
  assert.throws(() => auditBoatFishWeights(catalog, (min, max, first, second) => min
    + (first && second ? Math.floor((max - min) * first / 10000) : 0)), /not uniformly spread/);
});

test("every legally owned old rod, hook and compatible bait remains usable without repurchasing", () => {
  const current = state(); let checked = 0;
  for (const rod of catalog.fishing.rods) for (const hook of catalog.fishing.hooks) for (const bait of [null, ...catalog.fishing.baits.map(row => row.itemId)]) {
    if (!fishingBaitCompatible(rod.id, bait)) continue;
    Object.assign(current.fishing, { equippedRodId: rod.id, equippedHookId: hook.id, equippedBaitId: bait });
    if (bait) current.inventory[bait] = 1;
    assert.equal(boatDepartureReason(current, epoch), null); checked++;
  }
  assert.equal(checked, 1104);
  current.fishing.ownedRods = [];
  assert.match(boatDepartureReason(current, epoch), /свои удочку/);
});

test("real departures freeze caps and mass, spend one bait, and gain no road or weight advantage from food, skills, taps or pearls", () => {
  for (const upgrades of [[], ["crate"], ["oars"], ["crate", "oars"]]) {
    const plain = state({ upgrades }), helped = state({ upgrades, artifacts: ["landing_net", "telescope"], boosted: true });
    const foodBefore = structuredClone(helped.food), tackleBefore = structuredClone(helped.fishing);
    departure(plain); departure(helped);
    for (const current of [plain, helped]) {
      assert.equal(current.inventory.crumb_bait, 9);
      assert.equal(current.boat.voyage.maxCasts, 4 + Number(upgrades.includes("crate")));
      assert.equal(current.boat.voyage.maxCatches, current.boat.voyage.maxCasts);
      assert.equal(current.boat.voyage.slots.length, current.boat.voyage.maxCasts);
      assert.equal(current.boat.voyage.outboundSeconds, upgrades.includes("oars") ? 240 : 300);
      assert.equal(current.boat.voyage.inboundSeconds, current.boat.voyage.outboundSeconds);
    }
    const masses = current => current.boat.voyage.slots.map(({ fishId, weightGrams }) => ({ fishId, weightGrams }));
    assert.deepEqual(masses(helped), masses(plain));
    assert(plain.boat.voyage.slots.every(slot => slot.zoneWidth === 3200));
    assert(helped.boat.voyage.slots.every(slot => slot.zoneWidth === 4000));
    assert.deepEqual(helped.food, foodBefore); assert.deepEqual(helped.fishing, tackleBefore);
    assert.equal(helped.wallet.pearls, 10000);
  }
});

test("a successful control trace keeps the preselected grams and cannot credit inventory before returning", () => {
  const current = state({ artifacts: ["landing_net"] }), run = departure(current, () => 0);
  const id = current.boat.voyage.id, arrives = Date.parse(current.boat.voyage.arrivesAt), chosen = structuredClone(current.boat.voyage.slots[0]);
  run("begin_boat_cast", id, arrives);
  const view = publicBoatState(current.boat), challenge = current.boat.voyage.challenge;
  assert.equal(view.voyage.slots, undefined); assert.equal(view.voyage.challenge.weightGrams, undefined);
  const trace = play(challenge);
  assert.equal(trace.status, "caught", "the bounded reference controller can land the authored easy fixture");
  const finished = Date.parse(challenge.biteAt) + trace.command.endTick * challenge.tickMs;
  run("submit_boat_cast", id, finished, { reel: trace.command });
  assert.equal(current.boat.voyage.catches[0].weightGrams, chosen.weightGrams);
  assert.equal(current.boat.voyage.catches[0].fishId, chosen.fishId);
  assert.deepEqual(current.fishing.catches, {}); assert.deepEqual(current.boat.records, {});
  run("return_boat", id, finished);
  const returns = Date.parse(current.boat.voyage.returnsAt), before = structuredClone(current);
  assert.throws(() => run("claim_boat", id, returns - 1), { code: "ECONOMY_BOAT_PHASE" });
  assert.deepEqual(current, before);
  run("claim_boat", id, returns);
  assert.equal(current.boat.records[chosen.fishId].weightGrams, chosen.weightGrams);
  assert.equal(current.fishing.catches[chosen.fishId], 1);
  assert.equal(current.boat.qualifiedVoyages, 0, "an early one-cast return is not a completed full-attempt outing");
});

test("letting every challenge expire spends every fixed attempt and never creates fish or blueprint progress", () => {
  const current = state(), run = departure(current);
  const id = current.boat.voyage.id, slots = structuredClone(current.boat.voyage.slots);
  let at = Date.parse(current.boat.voyage.arrivesAt);
  for (let index = 0; index < slots.length; index++) {
    run("begin_boat_cast", id, at);
    assert.equal(current.boat.voyage.castsUsed, index + 1);
    assert.equal(current.boat.voyage.challenge.seed, slots[index].challengeSeed);
    const before = structuredClone(current);
    assert.throws(() => run("begin_boat_cast", id, at), { code: "ECONOMY_BOAT_CAST_ACTIVE" });
    assert.deepEqual(current, before);
    at = Date.parse(current.boat.voyage.challenge.expiresAt);
  }
  assert.throws(() => run("begin_boat_cast", id, at), { code: "ECONOMY_BOAT_CAST_LIMIT" });
  assert.deepEqual(current.boat.voyage.slots, slots);
  run("return_boat", id, at); at = Date.parse(current.boat.voyage.returnsAt);
  run("claim_boat", id, at);
  assert.equal(current.boat.completedVoyages, 1); assert.equal(current.boat.qualifiedVoyages, 0);
  assert.deepEqual(current.boat.blueprints, { landing_net: 0, telescope: 0 });
  assert.deepEqual(current.fishing.catches, {}); assert.deepEqual(current.boat.records, {});
});

test("full qualifying voyages cross all legacy thresholds without creating pages or duplicate claim rewards", () => {
  const current = state(); current.fishing.equippedBaitId = null;
  const run = driver(current);
  let at = epoch;
  for (let trip = 1; trip <= 16; trip++) {
    run("depart_boat", catalog.boat.routeId, at);
    const voyage = current.boat.voyage, id = voyage.id, slot = voyage.slots[0];
    at = Date.parse(voyage.arrivesAt);
    // Supplied persisted outcome isolates delivery and qualification from control skill.
    voyage.castsUsed = voyage.maxCasts;
    voyage.catches = [{ castIndex: 0, fishId: slot.fishId, weightGrams: slot.weightGrams, caughtAt: new Date(at).toISOString() }];
    run("return_boat", id, at); at = Date.parse(current.boat.voyage.returnsAt);
    const before = structuredClone(current.boat);
    run("claim_boat", id, at);
    assert.equal(boatClaimPracticeSeconds(before, current.boat, "claim_boat"), 150);
    assert.deepEqual(current.boat.blueprints, { landing_net: 0, telescope: 0 });
    const claimed = structuredClone(current);
    assert.throws(() => run("claim_boat", id, at), { code: "ECONOMY_BOAT_VOYAGE_GONE" });
    assert.deepEqual(current, claimed);
  }
  assert.equal(current.boat.qualifiedVoyages, 16);
  assert.deepEqual(current.boat.blueprints, { landing_net: 0, telescope: 0 });
});

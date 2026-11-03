import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { readFileSync } from "node:fs";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const boats = await vite.ssrLoadModule("/features/economy/domain/boat-fishing.ts");
const schema = await vite.ssrLoadModule("/features/economy/domain/boat-model.ts");
const physics = await vite.ssrLoadModule("/features/economy/domain/boat-reel.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
after(() => vite.close());
const at = Date.parse("2026-11-03T10:00:00Z"), uuid = () => crypto.randomUUID();
const command = (action, targetId, extra = {}) => model.economyCommandSchema.parse({ requestId: uuid(), ownerPublicId: "0000-0000-0000", expectedRevision: 0, action, targetId, ...extra });
const fresh = () => {
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 3, workshopLevel: 3 });
  state.wallet.coins = 100000; state.inventory = { planks: 12, rope: 12, hardwood: 3 }; state.buildings.warehouse = 3;
  return state;
};
const run = (state, action, targetId, now = at, extra = {}, random = () => 37) => rules.applyEconomyCommand(state, command(action, targetId, extra), now, uuid, {}, random);
const ready = () => { const state = fresh(); state.boat.level = 1; return state; };
const depart = (state, now = at) => { run(state, "depart_boat", "river_reach", now); return state.boat.voyage; };
function play(challenge) {
  let state = physics.initialBoatReel(challenge), held = false; const inputs = [];
  while (state.status === "active") {
    const next = state.fish > state.bar + state.velocity * 4;
    if (next !== held) { inputs.push({ tick: state.tick, held: next }); held = next; }
    state = physics.stepBoatReel(challenge, state, held);
  }
  return { challengeId: challenge.id, inputs, endTick: state.tick, result: state };
}
const wireReel = played => ({ challengeId: played.challengeId, inputs: played.inputs, endTick: played.endTick });
function catchOne(state, now) {
  const voyage = state.boat.voyage; run(state, "begin_boat_cast", voyage.id, now);
  const played = play(state.boat.voyage.challenge); assert.equal(played.result.status, "caught");
  const reel = wireReel(played), finishedAt = Date.parse(state.boat.voyage.challenge.biteAt) + reel.endTick * 50;
  run(state, "submit_boat_cast", voyage.id, finishedAt, { reel });
  return finishedAt;
}

test("shared integer vectors fix unsigned seeds, negative inertia, segment edges and terminal results", () => {
  const vectors = JSON.parse(readFileSync(new URL("../apps/api/src/test/resources/world/boat-reel-vectors.json", import.meta.url), "utf8"));
  for (const vector of vectors.cases) {
    assert.deepEqual(physics.replayBoatReel(vector.challenge, vector.inputs, vector.endTick), vector.expected, vector.name);
    for (const checkpoint of vector.checkpoints)
      assert.deepEqual(physics.replayBoatReel(vector.challenge, vector.inputs.filter(input => input.tick < checkpoint.tick), checkpoint.tick), checkpoint, `${vector.name}@${checkpoint.tick}`);
  }
  for (const vector of vectors.weights)
    assert.equal(boats.boatFishWeight(vector.minGrams, vector.maxGrams, vector.first, vector.second), vector.expected);
});

test("boat defaults preserve old profiles and public projection never reveals sealed slots", () => {
  assert.deepEqual(schema.boatPrivateStateSchema.parse(undefined), boats.newBoatState());
  const state = ready(); depart(state);
  const before = structuredClone(state), publicState = boats.publicBoatState(state.boat);
  assert.ok(!("slots" in publicState.voyage)); assert.equal(publicState.voyage.catches.length, 0);
  publicState.upgrades.push("crate"); assert.deepEqual(state, before);
});
test("repair and ordinary construction share one builder, ready work remains reserved", () => {
  const state = fresh(); run(state, "start_boat_upgrade", "repair");
  assert.equal(state.wallet.coins, 99600); assert.equal(state.inventory.planks, 8); assert.equal(state.inventory.rope, 10);
  assert.throws(() => run(state, "start_construction", "woodlot"), { code: "ECONOMY_CONSTRUCTION_BUSY" });
  const work = state.boat.work;
  assert.throws(() => run(state, "claim_boat_upgrade", work.id), { code: "ECONOMY_BOAT_WORK_WAIT" });
  run(state, "claim_boat_upgrade", work.id, Date.parse(work.finishesAt)); assert.equal(state.boat.level, 1);
  assert.throws(() => run(state, "claim_boat_upgrade", work.id, Date.parse(work.finishesAt)), { code: "ECONOMY_BOAT_WORK_GONE" });
});
test("departures snapshot fixed times, loadout and every draw; consume one bait for the whole trip", () => {
  const state = ready(); state.inventory.crumb_bait = 2; state.fishing.equippedBaitId = "crumb_bait";
  state.boat.upgrades = ["crate", "oars"]; const voyage = depart(state);
  assert.equal(voyage.maxCasts, 5); assert.equal(voyage.outboundSeconds, 240); assert.equal(voyage.inboundSeconds, 240);
  assert.equal(voyage.slots.length, 5); assert.equal(state.inventory.crumb_bait, 1);
  state.fishing.equippedBaitId = null; assert.equal(voyage.loadout.baitId, "crumb_bait");
  assert.equal(Date.parse(voyage.arrivesAt) - at, 240000); assert.equal(Date.parse(voyage.fishingUntil) - Date.parse(voyage.arrivesAt), 1800000);
  for (const slot of voyage.slots) { const range = model.economyCatalog.boat.weights[slot.fishId]; assert.ok(slot.weightGrams >= range.minGrams && slot.weightGrams <= range.maxGrams); }
});
test("food, skills and landing net cannot change travel caps or the preselected mass", () => {
  const baseline = ready(), improved = ready();
  improved.boat.artifacts = ["landing_net"];
  improved.progression.skills.fishingSeconds = 31_536_000;
  improved.progression.skills.travelSeconds = 31_536_000;
  improved.food.heroMeal = "legendary_fish";
  improved.food.heroMealEffect = { remainingWorkSeconds: 3600, totalWorkSeconds: 3600, speedBps: 10000 };
  const foodBefore = structuredClone(improved.food), first = depart(baseline), second = depart(improved);
  assert.equal(first.arrivesAt, second.arrivesAt); assert.equal(first.inboundSeconds, second.inboundSeconds);
  assert.equal(first.maxCasts, second.maxCasts); assert.deepEqual(improved.food, foodBefore);
  assert.deepEqual(first.slots.map(slot => [slot.fishId, slot.weightGrams, slot.difficulty, slot.challengeSeed]), second.slots.map(slot => [slot.fishId, slot.weightGrams, slot.difficulty, slot.challengeSeed]));
  assert.ok(first.slots.every(slot => slot.zoneWidth === 3200)); assert.ok(second.slots.every(slot => slot.zoneWidth === 4000));
});
test("invalid trusted entropy commits neither bait nor voyage", () => {
  const state = ready(); state.inventory.crumb_bait = 2; state.fishing.equippedBaitId = "crumb_bait";
  const before = structuredClone(state);
  assert.throws(() => run(state, "depart_boat", "river_reach", at, {}, max => max), /Invalid trusted boat draw/);
  assert.deepEqual(state, before);
});
test("hero stays reserved throughout outbound, fishing, return and unclaimed arrival", () => {
  const state = ready(), voyage = depart(state);
  for (const now of [at, Date.parse(voyage.arrivesAt), boats.boatReturnsAt(voyage)]) {
    assert.throws(() => run(state, "start_fishing", "shore", now), { code: "ECONOMY_BOAT_BUSY" });
    assert.throws(() => run(state, "depart_boat", "river_reach", now), { code: "ECONOMY_BOAT_DEPARTURE" });
  }
});
test("reel traces preserve fixed-step results across reload and reject reordering or extra ticks", () => {
  const challenge = { id: uuid(), rulesVersion: 1, seed: 3902242211, tickMs: 50, maxTicks: 600, zoneWidth: 3200, difficulty: 4, startedAt: new Date(at).toISOString(), expiresAt: new Date(at + 120000).toISOString() };
  const played = play(challenge); assert.equal(played.result.status, "caught");
  assert.deepEqual(physics.replayBoatReel(challenge, played.inputs, played.endTick), played.result);
  const reloaded = JSON.parse(JSON.stringify({ challenge, inputs: played.inputs }));
  assert.deepEqual(physics.replayBoatReel(reloaded.challenge, reloaded.inputs, played.endTick), played.result);
  assert.throws(() => physics.replayBoatReel(challenge, [{ tick: 2, held: true }, { tick: 1, held: false }], 10));
  assert.throws(() => physics.replayBoatReel(challenge, played.inputs, played.endTick + 1));
});
test("catch is sealed before bite, server verifies time and controls, no client win or duplicate result", () => {
  const state = ready(), voyage = depart(state), now = Date.parse(voyage.arrivesAt), slot = structuredClone(voyage.slots[0]);
  run(state, "begin_boat_cast", voyage.id, now);
  const challenge = state.boat.voyage.challenge, played = play(challenge), { result, ...reel } = played;
  assert.equal(result.status, "caught");
  assert.throws(() => run(state, "submit_boat_cast", voyage.id, now, { reel }), { code: "ECONOMY_BOAT_TRACE" });
  assert.throws(() => command("submit_boat_cast", voyage.id, { reel: { ...reel, win: true } }));
  run(state, "submit_boat_cast", voyage.id, Date.parse(challenge.biteAt) + reel.endTick * 50, { reel });
  assert.equal(state.boat.voyage.catches[0].weightGrams, slot.weightGrams); assert.equal(state.boat.voyage.catches[0].fishId, slot.fishId);
  assert.deepEqual(state.fishing.catches, {}, "records and fish remain in the boat until claim");
  assert.throws(() => run(state, "submit_boat_cast", voyage.id, now + 30000, { reel }), { code: "ECONOMY_BOAT_CAST_GONE" });
});
test("expired or escaped casts consume one fixed slot, never reset attempts", () => {
  const state = ready(), voyage = depart(state), now = Date.parse(voyage.arrivesAt);
  run(state, "begin_boat_cast", voyage.id, now); const challenge = structuredClone(state.boat.voyage.challenge);
  assert.throws(() => run(state, "begin_boat_cast", voyage.id, now + 1000), { code: "ECONOMY_BOAT_CAST_ACTIVE" });
  const played = play(challenge); const reel = wireReel(played);
  assert.throws(() => run(state, "submit_boat_cast", voyage.id, now + 120000, { reel }), { code: "ECONOMY_BOAT_CAST_EXPIRED" });
  run(state, "begin_boat_cast", voyage.id, now + 120000);
  assert.equal(state.boat.voyage.castsUsed, 2); assert.notEqual(state.boat.voyage.challenge.id, challenge.id);
  assert.equal(state.boat.voyage.challenge.seed, state.boat.voyage.slots[1].challengeSeed);
});
test("automatic return is a pure time projection; empty arrival gives no skill or fragment", () => {
  const state = ready(), voyage = depart(state), before = structuredClone(state), end = boats.boatReturnsAt(voyage);
  assert.equal(boats.boatPhase(state.boat, Date.parse(voyage.fishingUntil)), "returning");
  assert.equal(boats.boatPhase(state.boat, end), "ready"); assert.deepEqual(state, before);
  const skill = state.progression.skills.fishingSeconds; run(state, "claim_boat", voyage.id, end);
  assert.equal(state.progression.skills.fishingSeconds, skill); assert.equal(state.boat.qualifiedVoyages, 0); assert.equal(state.boat.blueprints.landing_net, 0);
});
test("qualifying and partial voyages preserve legacy pages and permanent items without awarding new fragments", () => {
  const state = ready(); let now = at;
  state.boat.blueprints = { landing_net: 2, telescope: 1 };
  state.boat.artifacts = ["landing_net", "telescope"];
  const pages = structuredClone(state.boat.blueprints), artifacts = [...state.boat.artifacts];
  for (let trip = 1; trip <= 14; trip++) {
    const voyage = depart(state, now); now = Date.parse(voyage.arrivesAt);
    for (let i = 0; i < voyage.maxCasts; i++) now = catchOne(state, now + 1);
    run(state, "return_boat", voyage.id, now); now += voyage.inboundSeconds * 1000;
    run(state, "claim_boat", voyage.id, now); state.inventory = {};
    assert.deepEqual(state.boat.blueprints, pages);
    assert.deepEqual(state.boat.artifacts, artifacts);
  }
  const voyage = depart(state, now); now = catchOne(state, Date.parse(voyage.arrivesAt));
  run(state, "return_boat", voyage.id, now); now += voyage.inboundSeconds * 1000; run(state, "claim_boat", voyage.id, now);
  assert.equal(state.boat.completedVoyages, 15); assert.equal(state.boat.qualifiedVoyages, 14);
  assert.deepEqual(state.boat.blueprints, pages);
  assert.deepEqual(state.boat.artifacts, artifacts);
});
test("a saved paid artifact job remains claimable once without a second cost or losing old pages", () => {
  const state = ready(), id = uuid(), upgrade = model.economyCatalog.boat.upgrades.find(entry => entry.id === "landing_net");
  state.boat.blueprints = { landing_net: 3, telescope: 1 };
  state.boat.work = { id, upgradeId: "landing_net", startedAt: new Date(at).toISOString(),
    finishesAt: new Date(at + upgrade.seconds * 1000).toISOString(), cost: structuredClone(upgrade.cost) };
  const saved = JSON.parse(JSON.stringify(state)), wallet = structuredClone(saved.wallet), inventory = structuredClone(saved.inventory);
  run(saved, "claim_boat_upgrade", id, Date.parse(saved.boat.work.finishesAt));
  assert.deepEqual(saved.wallet, wallet); assert.deepEqual(saved.inventory, inventory);
  assert.deepEqual(saved.boat.blueprints, { landing_net: 3, telescope: 1 });
  assert.deepEqual(saved.boat.artifacts, ["landing_net"]); assert.equal(saved.boat.work, undefined);
  const claimed = structuredClone(saved);
  assert.throws(() => run(saved, "claim_boat_upgrade", id, at + upgrade.seconds * 1000), { code: "ECONOMY_BOAT_WORK_GONE" });
  assert.deepEqual(saved, claimed);
});
test("full storage failure is atomic, then claim awards once including species, mass and bounded practice", () => {
  const state = ready(), voyage = depart(state); let now = Date.parse(voyage.arrivesAt);
  for (let i = 0; i < voyage.maxCasts; i++) now = catchOne(state, now + 1);
  run(state, "return_boat", voyage.id, now); now += voyage.inboundSeconds * 1000;
  const delivery = structuredClone(state.boat.voyage.catches), skill = state.progression.skills.fishingSeconds;
  state.inventory = { wood: rules.economyStorage(state).capacity }; const before = structuredClone(state);
  assert.throws(() => run(state, "claim_boat", voyage.id, now), { code: "ECONOMY_STORAGE_FULL" }); assert.deepEqual(state, before);
  state.inventory = {}; run(state, "claim_boat", voyage.id, now);
  assert.equal(state.boat.voyage, undefined); assert.equal(Object.values(state.inventory).reduce((a, b) => a + b, 0), 4);
  assert.equal(Object.values(state.fishing.catches).reduce((a, b) => a + b, 0), 4);
  assert.equal(Object.values(state.fishing.stock).reduce((a, b) => a + b, 0), 4);
  assert.deepEqual(state.boat.blueprints, { landing_net: 0, telescope: 0 }); assert.equal(state.boat.qualifiedVoyages, 1);
  assert.equal(state.progression.skills.fishingSeconds - skill, 600);
  for (const fish of delivery) assert.ok(state.boat.records[fish.fishId].weightGrams >= fish.weightGrams);
  const claimed = structuredClone(state); assert.throws(() => run(state, "claim_boat", voyage.id, now), { code: "ECONOMY_BOAT_VOYAGE_GONE" }); assert.deepEqual(state, claimed);
});


test("a cast publishes only its actual rarity and waits 4–7 seconds before any valid replay can finish", () => {
  const state = ready(), voyage = depart(state), started = Date.parse(voyage.arrivesAt);
  const rarity = model.economyCatalog.fishing.fish.find(fish => fish.itemId === voyage.slots[0].fishId).rarity;
  run(state, "begin_boat_cast", voyage.id, started);
  const challenge = state.boat.voyage.challenge, bite = Date.parse(challenge.biteAt), played = play(challenge), reel = wireReel(played);
  assert.ok(bite - started >= 4000 && bite - started <= 7000);
  assert.equal(challenge.fishRarity, rarity);
  assert.equal(challenge.rulesVersion, 4);
  assert.equal(challenge.resistance, physics.boatResistanceForClass(rarity, challenge.seed));
  const publicChallenge = boats.publicBoatState(state.boat).voyage.challenge;
  assert.equal(publicChallenge.resistance, challenge.resistance);
  assert.equal(publicChallenge.biteAt, challenge.biteAt); assert.equal(publicChallenge.fishRarity, rarity);
  assert.equal(publicChallenge.fishId, undefined); assert.equal(publicChallenge.weightGrams, undefined);
  assert.equal(boats.publicBoatState(state.boat).voyage.slots, undefined);
  const before = structuredClone(state), finish = bite + reel.endTick * 50;
  assert.throws(() => run(state, "submit_boat_cast", voyage.id, started + reel.endTick * 50, { reel }), { code: "ECONOMY_BOAT_TRACE" });
  assert.throws(() => run(state, "submit_boat_cast", voyage.id, finish - 1, { reel }), { code: "ECONOMY_BOAT_TRACE" });
  assert.deepEqual(state, before);
  const restored = schema.boatPrivateStateSchema.parse(JSON.parse(JSON.stringify(state.boat)));
  assert.deepEqual(restored.voyage.challenge, challenge);
  run(state, "submit_boat_cast", voyage.id, finish, { reel });
  assert.equal(state.boat.voyage.catches[0].fishId, voyage.slots[0].fishId);
});

test("legacy attempts stay playable without bite metadata and a too-late new cast spends no attempt", () => {
  const state = ready(), voyage = depart(state), started = Date.parse(voyage.arrivesAt);
  run(state, "begin_boat_cast", voyage.id, started);
  const challenge = state.boat.voyage.challenge;
  challenge.rulesVersion = 1; delete challenge.resistance; delete challenge.biteAt; delete challenge.fishRarity;
  assert.equal(schema.boatChallengeSchema.safeParse(challenge).success, true);
  const reel = wireReel(play(challenge));
  run(state, "submit_boat_cast", voyage.id, started + reel.endTick * 50, { reel });
  const before = structuredClone(state), tooLate = Date.parse(voyage.fishingUntil) - 1000;
  assert.throws(() => run(state, "begin_boat_cast", voyage.id, tooLate), { code: "ECONOMY_BOAT_CAST_WAIT" });
  assert.deepEqual(state, before);
  const nextWait = (4 + state.boat.voyage.slots[state.boat.voyage.castsUsed].challengeSeed % 4) * 1000;
  const boundary = Date.parse(voyage.fishingUntil) - nextWait - 50;
  assert.throws(() => run(state, "begin_boat_cast", voyage.id, boundary), { code: "ECONOMY_BOAT_CAST_WAIT" });
  assert.deepEqual(state, before);
  assert.equal(schema.boatChallengeSchema.safeParse({ ...challenge, biteAt: challenge.expiresAt }).success, false);
  assert.equal(schema.boatChallengeSchema.safeParse({ ...challenge, fishRarity: "invented" }).success, false);
});

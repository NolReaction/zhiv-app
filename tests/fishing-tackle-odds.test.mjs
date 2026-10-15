import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { economicMath } from "../scripts/lib/economy-math.mjs";
import { auditFishingBalance } from "../scripts/audit-fishing-balance.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const { economyCatalog, economyFishingCatalogSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { fishingOdds, fishingWeights, fishingClassOdds, fishingClassWeights, fishingIneligibility, fishingBaitCompatible, selectFishingCatch } = await vite.ssrLoadModule("/features/economy/domain/fishing.ts");
after(() => vite.close());
const catalog = economyCatalog.fishing;
const baits = [null, ...catalog.baits.map(bait => bait.itemId)];
const odds = (rodId, hookId, baitId) => fishingOdds({}, catalog, { rodId, hookId, baitId });
const classChance = (row, rarity, spec = catalog) => row.filter(odd => spec.fish.find(fish => fish.itemId === odd.itemId).rarity === rarity)
  .reduce((sum, odd) => sum + odd.probability, 0);

test("every loadout agrees with the audit and any hook works with the legendary rod", () => {
  const math = economicMath(economyCatalog);
  let combinations = 0;
  for (const rod of catalog.rods) for (const hook of catalog.hooks) for (const baitId of baits) {
    const chances = odds(rod.id, hook.id, baitId), mathChances = math.catchPortfolio(rod.id, baitId, "shore", hook.id).probabilities;
    assert.ok(Math.abs(chances.reduce((sum, fish) => sum + fish.probability, 0) - 1) < 1e-12);
    for (const fish of chances) assert.ok(Math.abs(fish.probability - mathChances[fish.itemId]) < 1e-12);
    assert.equal(chances.find(fish => fish.itemId === "fish_shark").probability > 0, rod.rarity === "legendary");
    combinations++;
  }
  assert.equal(combinations, catalog.rods.length * catalog.hooks.length * baits.length);
});

test("rod-only odds are explicit percentages and each specialist targets at least 55 percent without equipment combinations", () => {
  const targets = { river_rod: "uncommon", brook_rod: "uncommon", willow_rod: "rare", tide_rod: "epic", starfall_rod: "legendary" };
  for (const rod of catalog.rods) {
    const weights = fishingClassWeights(rod.id, null, catalog, "bare_hook");
    assert.deepEqual(Object.fromEntries(weights.map(group => [group.rarity, group.weight])), rod.classOddsBps);
    assert.equal(weights.reduce((sum, group) => sum + group.weight, 0), 10000);
    if (targets[rod.id]) assert.ok(rod.classOddsBps[targets[rod.id]] >= 5500);
  }
  assert.equal(classChance(odds("starfall_rod", "bare_hook", null), "legendary"), .6);
  assert.equal(classChance(odds("tide_rod", "bare_hook", null), "epic"), .65);
});

test("matching hook and bait multiply the rod tickets and improve its intended class", () => {
  const targets = { uncommon: ["river_rod", "barbed_hook", "worm_bait"], rare: ["willow_rod", "silver_hook", "glow_bait"],
    epic: ["tide_rod", "tide_hook", "firefly_bait"], legendary: ["starfall_rod", "leviathan_hook", "star_bait"] };
  for (const [rarity, [rodId, hookId, baitId]] of Object.entries(targets)) {
    const rod = catalog.rods.find(rod => rod.id === rodId);
    const base = classChance(odds(rodId, "bare_hook", null), rarity);
    const hook = classChance(odds(rodId, hookId, null), rarity);
    const both = classChance(odds(rodId, hookId, baitId), rarity);
    assert.ok(hook > base && both > hook && both < 1);
    const enhanced = Math.floor(rod.classOddsBps[rarity] * 150 * 150 / 10000);
    assert.ok(Math.abs(both - enhanced / (10000 - rod.classOddsBps[rarity] + enhanced)) < 1e-12);
  }
  const p = classChance(odds("starfall_rod", "leviathan_hook", "star_bait"), "legendary");
  const report = auditFishingBalance(economyCatalog), legendary = report.targets.find(target => target.rarity === "legendary");
  assert.equal(report.examinedCombinations, catalog.rods.length * catalog.hooks.length * baits.length);
  const compatible = catalog.rods.reduce((sum, rod) => sum + baits.filter(baitId => fishingBaitCompatible(rod.id, baitId)).length * catalog.hooks.length, 0);
  assert.equal(report.combinations, compatible);
  assert.equal(report.combinations + report.incompatibleBaits.length, report.examinedCombinations);
  assert.equal(legendary.probabilityPerFish, Number(p.toFixed(9)));
  assert.equal(legendary.probabilityAtLeastOneInCamp, Number((1 - (1 - p) ** 8).toFixed(9)));
  assert.ok(report.incomeRanges.every(row => row.minimumNetSaleCoinsPerHour > 0));
});

test("zero rod classes remain impossible even with the strongest hook and bait", () => {
  const zeroRod = catalog.rods.find(rod => rod.id === "reed_rod");
  for (const hook of catalog.hooks) for (const baitId of baits) {
    const weights = fishingClassWeights(zeroRod.id, baitId, catalog, hook.id);
    for (const group of weights) if (zeroRod.classOddsBps[group.rarity] === 0) assert.equal(group.weight, 0);
  }
  const epic = catalog.fish.find(fish => fish.rarity === "epic");
  assert.equal(fishingIneligibility(epic, "reed_rod", "tide_hook", catalog), "rod_class");
  const spec = structuredClone(catalog);
  spec.rods[0].classOddsBps = { common: 10000, uncommon: 0, rare: 0, epic: 0, legendary: 0 };
  for (let index = 0; index < 100; index++) {
    const id = selectFishingCatch(`zero-class-${index}`, "reed_rod", "star_bait", spec, "leviathan_hook");
    assert.equal(spec.fish.find(fish => fish.itemId === id).rarity, "common");
  }
});

test("all collection species are uniform within their class including added legendary fish on every hook", () => {
  const spec = structuredClone(catalog);
  spec.fish.push({ itemId: "fish_second_legendary", rarity: "legendary", description: "Test collection species", buyPrice: 1600, requiredHookId: "missing_hook", weight: 9999, affinity: 10 });
  for (const hook of catalog.hooks) {
    const chances = fishingOdds({}, spec, { rodId: "starfall_rod", hookId: hook.id, baitId: null });
    for (const group of spec.classes) {
      const members = chances.filter(row => spec.fish.find(fish => fish.itemId === row.itemId).rarity === group.rarity);
      assert.ok(members.every(row => row.probability === members[0].probability));
    }
    const first = chances.find(row => row.itemId === "fish_shark").probability;
    assert.equal(chances.find(row => row.itemId === "fish_second_legendary").probability, first);
    assert.ok(first > 0);
    assert.ok(Math.abs(classChance(chances, "legendary", spec) - classChance(odds("starfall_rod", hook.id, null), "legendary")) < 1e-12);
  }
  const epics = fishingOdds({}, catalog, { rodId: "tide_rod", hookId: "bare_hook", baitId: null })
    .filter(row => catalog.fish.find(fish => fish.itemId === row.itemId).rarity === "epic");
  assert.equal(epics.length, 2); assert.equal(epics[0].probability, .65 / 2); assert.equal(epics[1].probability, .65 / 2);
});

test("adding collection species cannot change or reroll a cast's economic class", () => {
  const loadout = { rodId: "starfall_rod", hookId: "bare_hook", baitId: "star_bait" };
  const expanded = structuredClone(catalog);
  expanded.fish.push({ ...expanded.fish.find(fish => fish.rarity === "uncommon"), itemId: "fish_collection_test", weight: 9999 });
  const original = fishingClassOdds({}, catalog, loadout), modified = fishingClassOdds({}, expanded, loadout);
  assert.deepEqual(original, modified);
  for (let index = 0; index < 100; index++) {
    const seed = `server-class-invariance-${index}`;
    const first = selectFishingCatch(seed, loadout.rodId, loadout.baitId, catalog, loadout.hookId);
    const second = selectFishingCatch(seed, loadout.rodId, loadout.baitId, expanded, loadout.hookId);
    assert.equal(catalog.fish.find(fish => fish.itemId === first).rarity, expanded.fish.find(fish => fish.itemId === second).rarity);
  }
});

test("private class and species hash vectors match Kotlin for specialist gear and every camp draw", () => {
  const seeds = ["00000000-0000-4000-8000-000000000001", "a2f6bce4-1d99-4c0f-a910-656320724833", "ffffffff-ffff-4fff-bfff-ffffffffffff",
    "00000000-0000-4000-8000-00000000000f", "00000000-0000-4000-8000-00000000014a", "00000000-0000-4000-8000-000000000376"];
  assert.deepEqual(seeds.map(seed => selectFishingCatch(seed, "starfall_rod", "star_bait", catalog, "leviathan_hook")),
    ["fish_shark", "fish_shark", "fish_shark", "fish_shark", "fish_shark", "fish_shark"]);
  assert.deepEqual(seeds.map(seed => selectFishingCatch(seed, "starfall_rod", "firefly_bait", catalog, "tide_hook")),
    ["fish_mirror_koi", "fish_shark", "fish_sturgeon", "fish_shark", "fish_mirror_koi", "fish_shark"]);
  assert.deepEqual(Array.from({ length: 8 }, (_, index) => selectFishingCatch(seeds[0], "river_rod", "worm_bait", catalog, "barbed_hook", index)),
    ["fish_bream", "fish_bream", "fish_bream", "fish_dace", "fish_bream", "fish_dace", "fish_dace", "fish_dace"]);
});

test("bait boosts its class only where the rod allows it and all loadouts retain a positive trip value", () => {
  const math = economicMath(economyCatalog);
  for (const rod of catalog.rods) for (const hook of catalog.hooks) for (const bait of catalog.baits) {
    const rarity = Object.entries(bait.rarityWeights).find(([, multiplier]) => multiplier > 100)[0];
    const targeted = classChance(odds(rod.id, hook.id, bait.itemId), rarity), plain = classChance(odds(rod.id, hook.id, null), rarity);
    if (plain === 0) assert.equal(targeted, 0); else assert.ok(targeted > plain);
    assert.equal(fishingBaitCompatible(rod.id, bait.itemId), plain > 0);
    if (!fishingBaitCompatible(rod.id, bait.itemId)) continue;
    for (const routeId of catalog.routeIds) {
      const portfolio = math.catchPortfolio(rod.id, bait.itemId, routeId, hook.id);
      assert.ok(portfolio.expectedFishRevenue - portfolio.routeCoins - portfolio.baitPurchaseCoins > 0);
    }
  }
});

test("legacy snapshots keep a bounded fallback while current rod odds require five exact keys and sum10000", () => {
  const old = structuredClone(catalog);
  for (const rod of old.rods) { delete rod.classOddsBps; rod.rarityWeights = { common: 100, uncommon: 200, rare: 100, epic: 100, legendary: 100 }; }
  for (const fish of old.fish) { fish.weight = 9999; fish.affinity = 10; fish.requiredHookId = "irrelevant_legacy_hook"; }
  const parsed = economyFishingCatalogSchema.parse(old);
  const weights = fishingClassWeights("river_rod", null, parsed, "bare_hook");
  assert.equal(weights.find(group => group.rarity === "uncommon").weight, old.classes.find(group => group.rarity === "uncommon").weight * 2);
  assert.ok(fishingWeights("river_rod", null, parsed, "bare_hook").some(fish => fish.weight > 0));
  for (const modify of [
    values => { delete values.epic; }, values => { values.typo = 0; }, values => { values.common = -1; },
    values => { values.common = .5; }, values => { values.common++; },
  ]) { const changed = structuredClone(catalog); modify(changed.rods[0].classOddsBps); assert.equal(economyFishingCatalogSchema.safeParse(changed).success, false); }
});

test("every fish in both routes receives a draw and active fishing retains its authored yield", () => {
  const camp = economyCatalog.explorations.find(route => route.id === "shore_camp"), shore = economyCatalog.explorations.find(route => route.id === "shore");
  assert.deepEqual([shore.seconds, shore.rewards.fish, camp.seconds, camp.rewards.fish], [180, 2, 900, 8]);
  const math = economicMath(economyCatalog);
  for (const route of [shore, camp]) {
    assert.equal(catalog.collectionDrawsByRoute[route.id], route.rewards.fish);
    const portfolio = math.catchPortfolio("river_rod", "worm_bait", route.id, "barbed_hook");
    assert.equal(portfolio.speciesDrawsPerJob, route.rewards.fish);
    assert.ok(Math.abs(Object.values(portfolio.output).reduce((sum, n) => sum + n, 0) - route.rewards.fish) < 1e-12);
    assert.ok(Object.keys(portfolio.output).every(id => catalog.classes.some(group => group.itemId === id)));
  }
  assert.equal(shore.rewards.fish * 3600 / shore.seconds, 40); assert.equal(camp.rewards.fish * 3600 / camp.seconds, 32);
});

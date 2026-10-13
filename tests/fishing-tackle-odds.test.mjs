import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { economicMath } from "../scripts/lib/economy-math.mjs";
import { auditFishingBalance } from "../scripts/audit-fishing-balance.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const { economyCatalog, economyFishingCatalogSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { fishingOdds, fishingWeights, selectFishingCatch } = await vite.ssrLoadModule("/features/economy/domain/fishing.ts");
after(() => vite.close());
const catalog = economyCatalog.fishing;
const baits = [null, ...catalog.baits.map(bait => bait.itemId)];
const odds = (rodId, hookId, baitId) => fishingOdds({}, catalog, { rodId, hookId, baitId });

test("all 180 tackle combinations normalize and agree with the audit; legendary fish need both legendary gear pieces", () => {
  const math = economicMath(economyCatalog);
  const shark = catalog.fish.find(fish => fish.itemId === "fish_shark");
  const bestHook = catalog.hooks.reduce((best, hook) => hook.rareBonus > best.rareBonus ? hook : best);
  assert.equal(shark.requiredHookId, bestHook.id);
  let combinations = 0;
  for (const rod of catalog.rods) for (const hook of catalog.hooks) for (const baitId of baits) {
    const chances = odds(rod.id, hook.id, baitId), mathChances = math.catchPortfolio(rod.id, baitId, "shore", hook.id).probabilities;
    assert.ok(Math.abs(chances.reduce((sum, fish) => sum + fish.probability, 0) - 1) < 1e-12);
    for (const fish of chances) assert.ok(Math.abs(fish.probability - mathChances[fish.itemId]) < 1e-12);
    assert.equal(chances.find(fish => fish.itemId === shark.itemId).probability > 0, hook.rarity === "legendary" && rod.rarity === "legendary");
    combinations++;
  }
  assert.equal(combinations, 180);
});

const classChance = (row, rarity) => row.filter(odd => catalog.fish.find(fish => fish.itemId === odd.itemId).rarity === rarity)
  .reduce((sum, odd) => sum + odd.probability, 0);

test("class targeting remains distinct and legendary odds stay below ten percent per fish", () => {
  const targets = { uncommon: ["river_rod", "barbed_hook", "worm_bait", .62, .65],
    rare: ["willow_rod", "silver_hook", "glow_bait", .40, .43],
    epic: ["tide_rod", "tide_hook", "firefly_bait", .25, .27],
    legendary: ["starfall_rod", "leviathan_hook", "firefly_bait", .09, .10] };
  for (const [rarity, [rodId, hookId, baitId, minimum, maximum]] of Object.entries(targets)) {
    const target = classChance(odds(rodId, hookId, baitId), rarity);
    assert.ok(target >= minimum && target <= maximum, `${rarity}: ${target}`);
    for (const rod of catalog.rods) for (const hook of catalog.hooks) for (const bait of baits)
      assert.ok(classChance(odds(rod.id, hook.id, bait), rarity) <= target + 1e-12, `${rarity}: unexpected stronger loadout`);
  }
  const p = classChance(odds("starfall_rod", "leviathan_hook", "firefly_bait"), "legendary");
  const report = auditFishingBalance(economyCatalog);
  assert.equal(report.combinations, 180);
  const legendary = report.targets.find(target => target.rarity === "legendary");
  assert.equal(legendary.probabilityPerFish, Number(p.toFixed(9)));
  assert.equal(legendary.probabilityAtLeastOneInCamp, Number((1 - (1 - p) ** 8).toFixed(9)));
  assert.ok(legendary.probabilityAtLeastOneInCamp < 8 * p);
  assert.ok(report.incomeRanges.every(row => row.minimumNetSaleCoinsPerHour > 0
    && row.maximumNetSaleCoinsPerHour <= row.starterNetSaleCoinsPerHour * 2));
});

test("each specialist rod and hook wins a distinct collection target instead of a universal price ladder", () => {
  const roles = { reed_rod: "common", river_rod: "uncommon", willow_rod: "rare", tide_rod: "epic", starfall_rod: "legendary",
    bare_hook: "common", barbed_hook: "uncommon", silver_hook: "rare", tide_hook: "epic", leviathan_hook: "legendary" };
  for (const hook of catalog.hooks) for (const baitId of baits) for (const rod of catalog.rods.filter(rod => roles[rod.id])) {
    if (roles[rod.id] === "legendary" && hook.id !== "leviathan_hook") continue;
    const target = classChance(odds(rod.id, hook.id, baitId), roles[rod.id]);
    for (const other of catalog.rods.filter(other => other.id !== rod.id))
      assert.ok(target > classChance(odds(other.id, hook.id, baitId), roles[rod.id]), `${rod.id} must keep its ${roles[rod.id]} niche`);
  }
  for (const rod of catalog.rods) for (const baitId of baits) for (const hook of catalog.hooks.filter(hook => roles[hook.id])) {
    if (roles[hook.id] === "legendary" && rod.rarity !== "legendary") continue;
    const target = classChance(odds(rod.id, hook.id, baitId), roles[hook.id]);
    for (const other of catalog.hooks.filter(other => other.id !== hook.id))
      assert.ok(target > classChance(odds(rod.id, other.id, baitId), roles[hook.id]), `${hook.id} must keep its ${roles[hook.id]} niche`);
  }
});

test("the rarity gate applies before normalization to every legendary species, with or without a named hook", () => {
  const spec = structuredClone(catalog);
  spec.fish = spec.fish.map(fish => fish.itemId === "fish_shark" ? { ...fish, requiredHookId: null } : fish);
  for (const [rodId, hookId] of [["reed_rod", "leviathan_hook"], ["starfall_rod", "bare_hook"], ["missing_rod", "leviathan_hook"]]) {
    const withLegendary = fishingWeights(rodId, "firefly_bait", spec, hookId);
    assert.equal(withLegendary.find(fish => fish.itemId === "fish_shark").weight, 0);
    const withoutLegendary = { ...spec, fish: spec.fish.filter(fish => fish.rarity !== "legendary") };
    assert.deepEqual(fishingOdds({}, spec, { rodId, hookId, baitId: "firefly_bait" }).filter(fish => fish.itemId !== "fish_shark"),
      fishingOdds({}, withoutLegendary, { rodId, hookId, baitId: "firefly_bait" }));
  }
  assert.ok(fishingWeights("starfall_rod", "firefly_bait", spec, "leviathan_hook").find(fish => fish.itemId === "fish_shark").weight > 0);
  const wrongRequiredHook = { ...spec, fish: spec.fish.map(fish => fish.itemId === "fish_shark" ? { ...fish, requiredHookId: "tide_hook" } : fish) };
  assert.equal(fishingWeights("starfall_rod", "firefly_bait", wrongRequiredHook, "leviathan_hook").find(fish => fish.itemId === "fish_shark").weight, 0);
});

test("species inside each class are equiprobable and do not determine class odds", () => {
  const loadout = { rodId: "starfall_rod", hookId: "leviathan_hook", baitId: "firefly_bait" };
  const original = fishingOdds({}, catalog, loadout);
  for (const group of catalog.classes) {
    const members = catalog.fish.filter(fish => fish.rarity === group.rarity);
    const chances = members.map(fish => original.find(row => row.itemId === fish.itemId).probability);
    assert.ok(chances.every(chance => Math.abs(chance - chances[0]) < 1e-12));
  }
  const expanded = structuredClone(catalog);
  expanded.fish.push({ ...expanded.fish.find(fish => fish.rarity === "uncommon"), itemId: "fish_collection_test", weight: 9999 });
  const modified = fishingOdds({}, expanded, loadout);
  for (const group of catalog.classes) {
    const share = (rows, data) => rows.filter(row => data.fish.find(fish => fish.itemId === row.itemId).rarity === group.rarity)
      .reduce((sum, row) => sum + row.probability, 0);
    assert.ok(Math.abs(share(original, catalog) - share(modified, expanded)) < 1e-12);
  }
  // Expanding the collection must not reroll the economic class of an existing cast.
  for (let index = 0; index < 100; index++) {
    const seed = `server-class-invariance-${index}`;
    const first = selectFishingCatch(seed, loadout.rodId, loadout.baitId, catalog, loadout.hookId);
    const second = selectFishingCatch(seed, loadout.rodId, loadout.baitId, expanded, loadout.hookId);
    assert.equal(catalog.fish.find(fish => fish.itemId === first).rarity, expanded.fish.find(fish => fish.itemId === second).rarity);
  }
});

test("bait targets its advertised class and every affordable loadout has positive expected catch value", () => {
  const roles = ["common", "uncommon", "rare", "epic"];
  const math = economicMath(economyCatalog);
  for (const rod of catalog.rods) for (const hook of catalog.hooks) for (const [index, bait] of catalog.baits.entries()) {
    const targeted = odds(rod.id, hook.id, bait.itemId), plain = odds(rod.id, hook.id, null);
    assert.ok(classChance(targeted, roles[index]) > classChance(plain, roles[index]));
    assert.ok(catalog.fish.some(fish => targeted.find(row => row.itemId === fish.itemId).probability < plain.find(row => row.itemId === fish.itemId).probability));
    for (const routeId of catalog.routeIds) {
      const portfolio = math.catchPortfolio(rod.id, bait.itemId, routeId, hook.id);
      assert.ok(portfolio.expectedFishRevenue - portfolio.routeCoins - portfolio.baitPurchaseCoins > 0);
    }
  }
});

test("older gear snapshots receive display defaults without changing bonuses or requiring a hook for ordinary fish", () => {
  const old = structuredClone(catalog);
  for (const kind of ["rods", "hooks", "baits"]) for (const gear of old[kind]) { delete gear.rarity; delete gear.requiredHomeLevel; delete gear.rarityWeights; }
  for (const fish of old.fish) delete fish.requiredHookId;
  const parsed = economyFishingCatalogSchema.parse(old);
  assert.equal(parsed.rods.find(rod => rod.id === "willow_rod").rareBonus, 5);
  assert.ok(parsed.rods.every(rod => rod.rarity === "common" && rod.requiredHomeLevel === 1));
  assert.equal(parsed.fish[0].requiredHookId, undefined);
});

test("every fish in both routes receives a class draw; active fishing trades attention for a modest yield advantage", () => {
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
  assert.equal(shore.rewards.fish * 3600 / shore.seconds, 40);
  assert.equal(camp.rewards.fish * 3600 / camp.seconds, 32);
});

test("affordable mixed gear trades ordinary catch share for uncommon share between the two specialists", () => {
  for (const [mixed, plain, specialist, isRod] of [['brook_rod','reed_rod','river_rod',true],['round_hook','bare_hook','barbed_hook',false]]) {
    for (const baitId of baits) {
      const row = id => isRod ? odds(id,'bare_hook',baitId) : odds('reed_rod',id,baitId);
      assert.ok(classChance(row(mixed),'common') < classChance(row(plain),'common'));
      assert.ok(classChance(row(mixed),'common') > classChance(row(specialist),'common'));
      assert.ok(classChance(row(mixed),'uncommon') > classChance(row(plain),'uncommon'));
      assert.ok(classChance(row(mixed),'uncommon') < classChance(row(specialist),'uncommon'));
    }
  }
});

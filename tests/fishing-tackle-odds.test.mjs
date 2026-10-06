import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { economicMath } from "../scripts/lib/economy-math.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const { economyCatalog, economyFishingCatalogSchema } = await vite.ssrLoadModule("/features/economy/model.ts");
const { fishingOdds, selectFishingCatch } = await vite.ssrLoadModule("/features/economy/fishing.ts");
after(() => vite.close());
const catalog = economyCatalog.fishing;
const baits = [null, ...catalog.baits.map(bait => bait.itemId)];
const odds = (rodId, hookId, baitId) => fishingOdds({}, catalog, { rodId, hookId, baitId });

test("all 180 tackle combinations normalize and agree with the economic audit; only the best hook can catch a shark", () => {
  const math = economicMath(economyCatalog);
  const shark = catalog.fish.find(fish => fish.itemId === "fish_shark");
  const bestHook = catalog.hooks.reduce((best, hook) => hook.rareBonus > best.rareBonus ? hook : best);
  assert.equal(shark.requiredHookId, bestHook.id);
  let combinations = 0;
  for (const rod of catalog.rods) for (const hook of catalog.hooks) for (const baitId of baits) {
    const chances = odds(rod.id, hook.id, baitId), mathChances = math.catchPortfolio(rod.id, baitId, "shore", hook.id).probabilities;
    assert.ok(Math.abs(chances.reduce((sum, fish) => sum + fish.probability, 0) - 1) < 1e-12);
    for (const fish of chances) assert.equal(fish.probability, mathChances[fish.itemId]);
    assert.equal(chances.find(fish => fish.itemId === shark.itemId).probability > 0, hook.id === bestHook.id);
    combinations++;
  }
  assert.equal(combinations, 180);
});

const classChance = (row, rarity) => row.filter(odd => catalog.fish.find(fish => fish.itemId === odd.itemId).rarity === rarity)
  .reduce((sum, odd) => sum + odd.probability, 0);

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
    const target = classChance(odds(rod.id, hook.id, baitId), roles[hook.id]);
    for (const other of catalog.hooks.filter(other => other.id !== hook.id))
      assert.ok(target > classChance(odds(rod.id, other.id, baitId), roles[hook.id]), `${hook.id} must keep its ${roles[hook.id]} niche`);
  }
});

test("bait focuses on a class, with a downside and no expected sale-profit from adding bait on either route", () => {
  const roles = ["common", "uncommon", "rare", "epic"];
  const value = row => row.reduce((sum, odd) => sum + odd.probability * economyCatalog.items.find(item => item.id === odd.itemId).baseSellPrice, 0);
  for (const rod of catalog.rods) for (const hook of catalog.hooks) for (const [index, bait] of catalog.baits.entries()) {
    const targeted = odds(rod.id, hook.id, bait.itemId), plain = odds(rod.id, hook.id, null);
    assert.ok(classChance(targeted, roles[index]) > classChance(plain, roles[index]));
    assert.ok(catalog.fish.some(fish => targeted.find(row => row.itemId === fish.itemId).probability < plain.find(row => row.itemId === fish.itemId).probability));
    for (const draws of [1, 6]) assert.ok(draws * (value(targeted) - value(plain)) < bait.price);
  }
});

test("server UUID vectors include the shark boundary and match Kotlin without a client-selected reroll", () => {
  const seeds = ["00000000-0000-4000-8000-000000000001", "a2f6bce4-1d99-4c0f-a910-656320724833", "ffffffff-ffff-4fff-bfff-ffffffffffff",
    "00000000-0000-4000-8000-00000000000f", "00000000-0000-4000-8000-00000000014a", "00000000-0000-4000-8000-000000000376"];
  assert.deepEqual(seeds.map(seed => selectFishingCatch(seed, "starfall_rod", "firefly_bait", catalog, "leviathan_hook")),
    ["fish", "fish", "fish_silverfin", "fish_shark", "fish_shark", "fish_shark"]);
  assert.deepEqual(seeds.map(seed => selectFishingCatch(seed, "starfall_rod", "firefly_bait", catalog, "tide_hook")),
    ["fish", "fish", "fish_silverfin", "fish_mirror_koi", "fish_mirror_koi", "fish_mirror_koi"]);
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

test("camp contains six stable independent collection draws, while short trips remain more productive per hour", () => {
  const camp = economyCatalog.explorations.find(route => route.id === "shore_camp"), shore = economyCatalog.explorations.find(route => route.id === "shore");
  assert.deepEqual(camp.rewards, { fish: 24 });
  assert.equal(catalog.collectionDrawsByRoute.shore_camp, 6);
  assert.ok(camp.rewards.fish / camp.seconds < shore.rewards.fish / shore.seconds);
  assert.ok(6 / camp.seconds < 1 / shore.seconds);
  assert.deepEqual(Array.from({ length: 6 }, (_, index) => selectFishingCatch("00000000-0000-4000-8000-000000000001", "river_rod", "worm_bait", catalog, "barbed_hook", index)),
    ["fish", "fish_reedperch", "fish_reedperch", "fish", "fish_bream", "fish_bream"]);
  const math = economicMath(economyCatalog).catchPortfolio("river_rod", "worm_bait", "shore_camp", "barbed_hook");
  assert.equal(math.speciesDrawsPerJob, 6);
  assert.ok(Math.abs(Object.values(math.output).reduce((sum, n) => sum + n, 0) - 24) < 1e-12);
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

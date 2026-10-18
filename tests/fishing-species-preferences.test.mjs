import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog, economyCatalogSchema, economyFishingSchema, economyFishingCatalogSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { fishingClassWeights, fishingSpeciesWeights, fishClassInventory, fishingOdds, selectFishingCatch } = await vite.ssrLoadModule("/features/economy/domain/fishing.ts");
const { createFishingShop } = await vite.ssrLoadModule("/features/economy/domain/fishing-shop.ts");
const { FishingSpeciesOdds, FishingSpeciesFocus } = await vite.ssrLoadModule("/features/economy/ui/fishing/fishing-species-odds.tsx");
const fishing = economyCatalog.fishing, species = new Map(fishing.fish.map(fish => [fish.itemId, fish]));
const oldRods = ["reed_rod", "brook_rod", "river_rod", "willow_rod", "tide_rod", "starfall_rod", "traveller_rod", "marsh_rod", "dusk_rod"];
const oldHooks = ["bare_hook", "round_hook", "barbed_hook", "silver_hook", "tide_hook", "leviathan_hook", "braided_hook", "dusk_hook"];
const newRods = ["float_rod", "predator_rod", "mirror_rod", "abyss_rod"], newHooks = ["spoon_hook", "weedless_hook", "moth_hook", "deep_hook"];

function hash(value) {
  let h = 2166136261;
  for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  h = Math.imul(h ^ h >>> 16, 0x85ebca6b) >>> 0; h = Math.imul(h ^ h >>> 13, 0xc2b2ae35) >>> 0;
  return (h ^ h >>> 16) >>> 0;
}
function previousClass(seed, index, rodId, hookId, baitId) {
  const rod = fishing.rods.find(gear => gear.id === rodId), hook = fishing.hooks.find(gear => gear.id === hookId), bait = fishing.baits.find(gear => gear.itemId === baitId);
  const rows = fishing.classes.map(group => ({ ...group, weight: Math.floor(rod.classOddsBps[group.rarity]
    * (hook.rarityWeights?.[group.rarity] ?? 100) * (bait?.rarityWeights?.[group.rarity] ?? 100) / 10000) }));
  let roll = Math.floor(hash(`${seed}:${index}:class`) * rows.reduce((sum, row) => sum + row.weight, 0) / 4294967296);
  for (const row of rows) { if (roll < row.weight) return row.itemId; roll -= row.weight; }
  throw Error("Invalid reference class");
}

test("every old loadout keeps each deterministic economic class, delivered inventory, fish count and sale value", () => {
  let casts = 0;
  for (const rodId of oldRods) for (const hookId of oldHooks) for (const baitId of [null, ...fishing.baits.map(bait => bait.itemId)]) {
    for (let sample = 0; sample < 5; sample++) {
      const seed = `unchanged-class-${sample}`, expected = {}, caught = {};
      for (let index = 0; index < 8; index++) {
        const itemId = selectFishingCatch(seed, rodId, baitId, fishing, hookId, index);
        const classId = previousClass(seed, index, rodId, hookId, baitId);
        assert.equal(`fish_${species.get(itemId).rarity}`, classId);
        expected[classId] = (expected[classId] ?? 0) + 1; caught[itemId] = (caught[itemId] ?? 0) + 1; casts++;
      }
      const inventory = fishClassInventory(caught, fishing);
      assert.deepEqual(inventory, expected);
      assert.equal(Object.values(inventory).reduce((sum, count) => sum + count, 0), 8);
      const value = stock => Object.entries(stock).reduce((sum, [id, count]) => sum + economyCatalog.items.find(item => item.id === id).baseSellPrice * count, 0);
      assert.equal(value(inventory), value(expected));
    }
  }
  assert.equal(casts, oldRods.length * oldHooks.length * (fishing.baits.length + 1) * 40);
});

test("rod and hook species preferences multiply only inside the selected class and preserve access to every species", () => {
  const plain = fishingClassWeights("willow_rod", "glow_bait", fishing, "silver_hook");
  assert.deepEqual(fishingClassWeights("predator_rod", "glow_bait", fishing, "weedless_hook"), plain);
  const weights = fishingSpeciesWeights("predator_rod", "rare", fishing, "weedless_hook");
  assert.equal(weights.find(fish => fish.itemId === "fish_pike").weight / weights.reduce((sum, fish) => sum + fish.weight, 0), .75);
  assert.ok(weights.every(fish => fish.weight > 0));
  const totals = new Map(fishing.classes.map(group => [group.rarity, 0])), draws = 12000;
  for (let index = 0; index < draws; index++) {
    const id = selectFishingCatch(`weighted-sample-${index}`, "predator_rod", null, fishing, "weedless_hook");
    if (species.get(id).rarity === "rare") totals.set(id, (totals.get(id) ?? 0) + 1);
  }
  const rare = [...totals].filter(([id]) => species.get(id)?.rarity === "rare");
  const total = rare.reduce((sum, [, count]) => sum + count, 0);
  assert.ok(Math.abs(totals.get("fish_pike") / total - .75) < .025);
  assert.ok(rare.every(([, count]) => count > 500));
  for (const group of fishing.classes) {
    const probabilities = fishingOdds({}, fishing, { rodId: "abyss_rod", hookId: "deep_hook", baitId: "dusk_bait" });
    const total = probabilities.filter(row => species.get(row.itemId).rarity === group.rarity).reduce((sum, row) => sum + row.probability, 0);
    const classWeights = fishingClassWeights("abyss_rod", "dusk_bait", fishing, "deep_hook");
    assert.ok(Math.abs(total - classWeights.find(row => row.rarity === group.rarity).weight / classWeights.reduce((sum, row) => sum + row.weight, 0)) < 1e-12);
  }
});

test("all new rods and hooks can appear at Pleska and are explicitly stocked at Leaftail at the same catalog price", () => {
  const tiers = ["common", "uncommon", "rare", "epic", "legendary"], odds = fishing.shop.gearRarityBpsByHome[4];
  for (const [kind, entries, ids] of [["rod", fishing.rods, newRods], ["hook", fishing.hooks, newHooks]]) for (const id of ids) {
    const gear = entries.find(gear => gear.id === id), leaf = economyCatalog.leaftailShop.travelOffers.find(offer => offer.itemId === id);
    assert.equal(gear.shop, "plesk"); assert.equal(leaf.kind, kind); assert.equal(leaf.priceCoins, gear.price);
    const state = { buildings: { home: 5 }, fishing: { ...economyFishingSchema.parse(undefined),
      ownedRods: fishing.rods.filter(gear => kind !== "rod" || gear.id !== id).map(gear => gear.id),
      ownedHooks: fishing.hooks.filter(gear => kind !== "hook" || gear.id !== id).map(gear => gear.id) } };
    const ticket = tiers.slice(0, tiers.indexOf(gear.rarity)).reduce((sum, tier) => sum + odds[tier], 0);
    const shop = createFishingShop(state, 0, max => max === 10000 ? ticket : 0, `availability-${id}`);
    assert.equal(shop.offers.find(offer => offer.kind === kind)?.itemId, id);
    assert.equal(shop.offers.find(offer => offer.itemId === id)?.unitPrice, gear.price);
    const locked = createFishingShop({ ...state, buildings: { home: gear.requiredHomeLevel - 1 } }, 0, () => 0, `locked-${id}`);
    if (gear.requiredHomeLevel > 1) assert.ok(!locked.offers.some(offer => offer.itemId === id));
  }
});

test("old catalog snapshots remain uniform and species weights reject invalid tickets or unknown fish", () => {
  const old = structuredClone(fishing); for (const gear of [...old.rods, ...old.hooks]) delete gear.speciesWeights;
  assert.ok(economyFishingCatalogSchema.safeParse(old).success);
  const equal = fishingSpeciesWeights("willow_rod", "rare", old, "silver_hook"); assert.equal(new Set(equal.map(row => row.weight)).size, 1);
  for (const bad of [0, -1, .5, 1001]) {
    const changed = structuredClone(economyCatalog); changed.fishing.rods[0].speciesWeights = { fish: bad };
    assert.equal(economyCatalogSchema.safeParse(changed).success, false);
  }
  const unknown = structuredClone(economyCatalog); unknown.fishing.hooks[0].speciesWeights = { fish_typo: 100 };
  assert.equal(economyCatalogSchema.safeParse(unknown).success, false);
});

test("species preview is compact and uses actual weighted probabilities without discovering unknown fish", () => {
  const state = { catalog: economyCatalog, inventory: {}, fishing: { ...economyFishingSchema.parse(undefined), equippedRodId: "predator_rod", equippedHookId: "weedless_hook", catches: { fish_pike: 1 } } };
  const html = renderToStaticMarkup(createElement(FishingSpeciesOdds, { state }));
  assert.match(html, /<details[^>]*data-fishing-species-odds/); assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /Изумрудная щука/); assert.match(html, /data-hidden-fish/); assert.match(html, /<progress/);
  assert.match(html, /51,9% на одну рыбу/); assert.doesNotMatch(html, /Тёмный угорь/);
  assert.equal((html.match(/data-hidden-fish=/g) ?? []).length, 10, "all eligible species other than the caught pike stay hidden, including the legacy fish alias");
  const focus = renderToStaticMarkup(createElement(FishingSpeciesFocus, { state }));
  assert.match(focus, /75% внутри своего класса/); assert.match(focus, /data-species-focus/);
});

test("new weighted species draw vectors agree with authoritative Kotlin for every camp cast", () => {
  const seed = "00000000-0000-4000-8000-000000000001";
  const rows = [["predator_rod", "weedless_hook", "glow_bait", ["fish_pike", "fish_pike", "fish_pike", "fish_pike", "fish_eel", "fish_pike", "fish_pike", "fish_pike"]],
    ["mirror_rod", "moth_hook", "firefly_bait", Array(8).fill("fish_mirror_koi")],
    ["abyss_rod", "deep_hook", "dusk_bait", ["fish_sturgeon", "fish_shark", "fish_sturgeon", "fish_sturgeon", "fish_shark", "fish_shark", "fish_sturgeon", "fish_shark"]]];
  for (const [rod, hook, bait, expected] of rows) assert.deepEqual(Array.from({ length: 8 }, (_, index) => selectFishingCatch(seed, rod, bait, fishing, hook, index)), expected);
});

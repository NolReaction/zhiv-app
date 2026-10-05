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

test("all 125 tackle combinations normalize and agree with the economic audit; only the best hook can catch a shark", () => {
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
  assert.equal(combinations, 125);
});

test("upgrading any one tackle component cannot turn a saved quantile into a cheaper species", () => {
  const improves = (old, next) => {
    for (let end = 1; end < catalog.fish.length; end++) {
      const prefix = row => row.slice(0, end).reduce((sum, fish) => sum + fish.probability, 0);
      assert.ok(prefix(next) <= prefix(old) + 1e-12, `CDF inversion at species ${end}`);
    }
  };
  for (const hook of catalog.hooks) for (const baitId of baits)
    for (let i = 1; i < catalog.rods.length; i++) improves(odds(catalog.rods[i - 1].id, hook.id, baitId), odds(catalog.rods[i].id, hook.id, baitId));
  for (const rod of catalog.rods) for (const baitId of baits)
    for (let i = 1; i < catalog.hooks.length; i++) improves(odds(rod.id, catalog.hooks[i - 1].id, baitId), odds(rod.id, catalog.hooks[i].id, baitId));
  for (const rod of catalog.rods) for (const hook of catalog.hooks)
    for (let i = 1; i < baits.length; i++) improves(odds(rod.id, hook.id, baits[i - 1]), odds(rod.id, hook.id, baits[i]));
});

test("server UUID vectors include the shark boundary and match Kotlin without a client-selected reroll", () => {
  const seeds = ["00000000-0000-4000-8000-000000000001", "a2f6bce4-1d99-4c0f-a910-656320724833", "ffffffff-ffff-4fff-bfff-ffffffffffff",
    "00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-000000000284", "00000000-0000-4000-8000-000000000296"];
  assert.deepEqual(seeds.map(seed => selectFishingCatch(seed, "starfall_rod", "firefly_bait", catalog, "leviathan_hook")),
    ["fish_reedperch", "fish_silverfin", "fish", "fish_shark", "fish_shark", "fish_shark"]);
  assert.deepEqual(seeds.map(seed => selectFishingCatch(seed, "starfall_rod", "firefly_bait", catalog, "tide_hook")),
    ["fish_reedperch", "fish_silverfin", "fish", "fish_mirror_koi", "fish_mirror_koi", "fish_mirror_koi"]);
});

test("older gear snapshots receive display defaults without changing bonuses or requiring a hook for ordinary fish", () => {
  const old = structuredClone(catalog);
  for (const kind of ["rods", "hooks", "baits"]) for (const gear of old[kind]) { delete gear.rarity; delete gear.requiredHomeLevel; }
  for (const fish of old.fish) delete fish.requiredHookId;
  const parsed = economyFishingCatalogSchema.parse(old);
  assert.equal(parsed.rods.find(rod => rod.id === "willow_rod").rareBonus, 5);
  assert.ok(parsed.rods.every(rod => rod.rarity === "common" && rod.requiredHomeLevel === 1));
  assert.equal(parsed.fish[0].requiredHookId, undefined);
});

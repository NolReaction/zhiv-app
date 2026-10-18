import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { auditFishingBalance } from "../scripts/audit-fishing-balance.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { fishingClassOdds, fishingBaitCompatible, selectFishingCatch } = await vite.ssrLoadModule("/features/economy/domain/fishing.ts");
const fishing = economyCatalog.fishing;
const odds = (rodId, hookId = "bare_hook", baitId = null) =>
  Object.fromEntries(fishingClassOdds({}, fishing, { rodId, hookId, baitId }).map(row => [row.rarity, row.probability]));

test("Leaftail rods offer two useful directions without replacing the class specialists", () => {
  const targets = { traveller_rod: ["uncommon", "rare"], marsh_rod: ["common", "epic"], dusk_rod: ["epic", "legendary"] };
  const specialists = { common: "reed_rod", uncommon: "river_rod", rare: "willow_rod", epic: "tide_rod", legendary: "starfall_rod" };
  for (const [rodId, directions] of Object.entries(targets)) {
    const rod = fishing.rods.find(rod => rod.id === rodId), chances = odds(rodId);
    assert.equal(rod.shop, "leaftail");
    assert.ok(rod.requiredHomeLevel >= economyCatalog.leaftailShop.requiredHomeLevel);
    for (const rarity of directions) {
      assert.ok(chances[rarity] >= .3, `${rodId} has a meaningful ${rarity} share`);
      assert.ok(chances[rarity] < odds(specialists[rarity])[rarity], `${rodId} cannot displace the ${rarity} specialist`);
    }
  }
  assert.equal(odds("traveller_rod").legendary, 0);
  assert.equal(odds("marsh_rod").legendary, 0);
  assert.equal(odds("dusk_rod").legendary, .3);
  const boosted = odds("dusk_rod", "dusk_hook", "dusk_bait"), plain = odds("dusk_rod");
  assert.ok(boosted.epic > plain.epic && boosted.legendary > plain.legendary);
});

test("new tackle keeps every old class-winning loadout and the old maximum fishing income", () => {
  const report = auditFishingBalance(economyCatalog);
  assert.deepEqual(report.targets.map(({ rarity, rodId, hookId, baitId }) => [rarity, rodId, hookId, baitId]), [
    ["common", "reed_rod", "bare_hook", "crumb_bait"],
    ["uncommon", "river_rod", "barbed_hook", "worm_bait"],
    ["rare", "willow_rod", "silver_hook", "glow_bait"],
    ["epic", "tide_rod", "tide_hook", "firefly_bait"],
    ["legendary", "starfall_rod", "leviathan_hook", "star_bait"],
  ]);
  const old = structuredClone(economyCatalog);
  for (const kind of ["rods", "hooks", "baits"]) old.fishing[kind] = old.fishing[kind].filter(item => item.shop !== "leaftail");
  const previous = auditFishingBalance(old);
  for (const [index, row] of report.incomeRanges.entries()) {
    assert.ok(row.minimumNetSaleCoinsPerHour > 0);
    assert.equal(row.maximumNetSaleCoinsPerHour, previous.incomeRanges[index].maximumNetSaleCoinsPerHour);
    assert.equal(row.starterNetSaleCoinsPerHour, previous.incomeRanges[index].starterNetSaleCoinsPerHour);
  }
});

test("mixed baits cannot create missing rod classes and every new cast uses the existing species rules", () => {
  assert.equal(fishingBaitCompatible("reed_rod", "dusk_bait", fishing), false);
  assert.equal(fishingBaitCompatible("traveller_rod", "spice_bait", fishing), true);
  for (const rod of fishing.rods.filter(rod => rod.shop === "leaftail")) {
    for (let index = 0; index < 100; index++) {
      const itemId = selectFishingCatch(`travelling-loadout-${index}`, rod.id, "dusk_bait", fishing, "dusk_hook");
      const species = fishing.fish.find(species => species.itemId === itemId);
      assert.ok(species);
      assert.ok(rod.classOddsBps[species.rarity] > 0);
    }
  }
});

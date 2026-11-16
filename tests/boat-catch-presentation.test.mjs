import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { boatCatchSize, boatCatchPresentation, boatAlbumEntries } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-catch-presentation.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { newEconomyState } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const now = "2026-11-03T12:00:00.000Z", fishId = "fish_silverfin";
const caught = (castIndex, weightGrams, id = fishId) => ({ castIndex, fishId: id, weightGrams, caughtAt: now });
function fixture() {
  const state = { ...newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 4, workshopLevel: 3 }), catalog: economyCatalog };
  state.boat.voyage = { id: crypto.randomUUID(), routeId: "river_reach", departedAt: now, arrivesAt: now,
    fishingUntil: "2026-11-03T12:30:00.000Z", maxCasts: 4, maxCatches: 4, castsUsed: 3, catches: [],
    loadout: { rodId: "reed_rod", hookId: "bare_hook", baitId: null }, outboundSeconds: 300, inboundSeconds: 300 };
  Object.defineProperty(state.boat.voyage, "slots", { get() { assert.fail("Presentation cannot inspect private future draws"); } });
  return state;
}

test("cosmetic weight tiers use species ranges with bounded scale and safe legacy fallbacks", () => {
  const range = { minGrams: 100, maxGrams: 1100 };
  assert.equal(boatCatchSize(100, range).tier, "small");
  assert.equal(boatCatchSize(350, range).tier, "normal");
  assert.equal(boatCatchSize(800, range).tier, "large");
  assert.equal(boatCatchSize(1000, range).tier, "trophy");
  assert.equal(boatCatchSize(-10, range).sizeScale, .78);
  assert.equal(boatCatchSize(5000, range).sizeScale, 1.3);
  assert.equal(boatCatchSize(100).sizeScale, 1);
  assert.equal(boatCatchSize(Number.NaN, range).tier, "normal");
});

test("new species and weight records compare confirmed prior catches without reading future slots", () => {
  const state = fixture(), first = caught(0, 300), next = caught(2, 650);
  state.boat.voyage.catches = [first, caught(1, 500), next];
  const initial = boatCatchPresentation(state, first);
  assert.equal(initial.isNewSpecies, true); assert.equal(initial.isRecord, false);
  const record = boatCatchPresentation(state, next);
  assert.equal(record.isNewSpecies, false); assert.equal(record.isRecord, true); assert.equal(record.previousBestGrams, 500);
  assert.equal(record.revealMs, 6000);
  state.boat.records[fishId] = { weightGrams: 900, caughtAt: now };
  assert.equal(boatCatchPresentation(state, next).isRecord, false);
  assert.equal(boatCatchPresentation(state, next).previousBestGrams, 900);
  state.fishing.catches[fishId] = 2; assert.equal(boatCatchPresentation(state, first).isNewSpecies, false);
});

test("the album keeps actual catch history after sales and labels onboard records as provisional", () => {
  const state = fixture(); state.inventory = { fish_common: 999 }; state.fishing.stock = { fish_common: 999 };
  assert.equal(boatAlbumEntries(state).filter(entry => entry.discovered).length, 0, "purchases cannot discover species");
  state.fishing.catches[fishId] = 2; state.boat.records[fishId] = { weightGrams: 300, caughtAt: now };
  state.boat.voyage.catches = [caught(0, 500)];
  let entry = boatAlbumEntries(state).find(entry => entry.fishId === fishId);
  assert.equal(entry.count, 3); assert.equal(entry.bestWeightGrams, 500); assert.equal(entry.onBoardCount, 1); assert.equal(entry.provisional, true);
  state.inventory = {}; state.fishing.stock = {}; state.boat.voyage.catches = [];
  entry = boatAlbumEntries(state).find(entry => entry.fishId === fishId);
  assert.equal(entry.discovered, true); assert.equal(entry.count, 2); assert.equal(entry.bestWeightGrams, 300);
  assert.equal(entry.provisional, false);
});

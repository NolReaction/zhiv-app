import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ configFile: false, root, appType: "custom", cacheDir: `/tmp/boat-catch-story-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { boatCatchStory } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-catch-story.ts");
const { BoatCatchCard } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-catch-card.tsx");
const { boatCatchPresentation } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-catch-presentation.ts");
const { newEconomyState } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const now = "2026-11-04T12:00:00.000Z";
const caught = (castIndex, weightGrams = 300, fishId = "fish_silverfin") => ({ castIndex, weightGrams, fishId, caughtAt: now });
function fixture(catches = []) {
  const state = { ...newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 4, workshopLevel: 3 }), catalog: economyCatalog };
  state.boat.voyage = { id: crypto.randomUUID(), routeId: "river_reach", departedAt: now, arrivesAt: now,
    fishingUntil: "2026-11-04T12:30:00.000Z", maxCasts: 5, maxCatches: 5, castsUsed: catches.length, catches,
    loadout: { rodId: "reed_rod", hookId: "bare_hook", baitId: null }, outboundSeconds: 300, inboundSeconds: 300 };
  Object.defineProperty(state.boat.voyage, "slots", { get() { assert.fail("catch detail must not read future draws"); } });
  return state;
}

test("confirmed species facts come from the catalog, with no invented notes for legacy IDs", () => {
  const state = fixture(), actual = caught(0);
  assert.equal(boatCatchStory(state, actual).note, economyCatalog.fishing.fish.find(fish => fish.itemId === actual.fishId).description);
  assert.equal(boatCatchStory(state, caught(0, 300, "unknown_legacy_fish")).note, "");
  assert.equal(boatCatchStory(state, caught(0, 300, "fish")).note, "Знакомая речная рыба.");
});

test("species count uses only confirmed catches through this cast and ignores purchases and other species", () => {
  const actual = caught(2, 600), state = fixture([caught(0), caught(1, 600, "fish_rudd"), actual, caught(3)]);
  state.inventory = { fish_silverfin: 999 }; state.fishing.catches.fish_silverfin = 99;
  assert.equal(boatCatchStory(state, actual).tripSpeciesCount, 2);
  assert.equal(boatCatchStory(state, state.boat.voyage.catches[0]).tripSpeciesCount, 1);
  state.boat.voyage = null;
  assert.equal(boatCatchStory(state, actual).tripSpeciesCount, 0);
});

test("record gain compares the real prior best without prolonging the catch reveal", () => {
  const actual = caught(2, 650), state = fixture([caught(0, 300), caught(1, 500), actual]);
  state.boat.records.fish_silverfin = { weightGrams: 450, caughtAt: now };
  assert.equal(boatCatchStory(state, actual).recordGainGrams, 150);
  assert.equal(boatCatchPresentation(state, actual).revealMs, 6000);
  state.boat.records.fish_silverfin.weightGrams = 900;
  assert.equal(boatCatchStory(state, actual).recordGainGrams, 0);
});

test("the card renders the actual species note, duplicate count and record delta without mutating state", () => {
  const actual = caught(2, 650), state = fixture([caught(0, 300), caught(1, 500), actual]);
  const before = structuredClone({ ...state, boat: { ...state.boat, voyage: { ...state.boat.voyage, slots: undefined } } });
  const html = renderToStaticMarkup(createElement(BoatCatchCard, { state, caught: actual }));
  assert.match(html, /Быстрая стайная рыбка с серебристой спинкой и голубыми плавниками\./u);
  assert.match(html, /Этого вида: 3 шт\./u); assert.match(html, /Прежний: 500 г · \+150 г/u);
  assert.doesNotMatch(html, /шанс|вероятность|процент|seed|slots/u);
  assert.deepEqual({ ...state, boat: { ...state.boat, voyage: { ...state.boat.voyage, slots: undefined } } }, before);
});

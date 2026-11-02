import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ configFile: false, appType: "custom", root, cacheDir: `/tmp/boat-blueprints-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyShipSchema } = await vite.ssrLoadModule("/features/economy/domain/ship-model.ts");
const { newEconomyState, economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { boatConfig, publicBoatState } = await vite.ssrLoadModule("/features/economy/domain/boat-fishing.ts");
const { BoatBlueprints } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-blueprints.tsx");
const at = Date.parse("2026-11-02T16:00:00Z");

function state() {
  const value = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 4, workshopLevel: 3 });
  value.wallet.coins = 100000; value.inventory = { planks: 20, rope: 20, hardwood: 20, lens: 20, metal_part: 20 };
  value.buildings.home = 4; value.buildings.workshop = 3; value.boat.level = 1;
  return value;
}
function render(value, disabled = false) {
  const before = structuredClone(value);
  const view = { ...value, ownerPublicId: "0000-0000-0000", revision: 1, serverTime: new Date(at).toISOString(),
    catalog: economyCatalog, boat: publicBoatState(value.boat), ship: economyShipSchema.parse(value.ship), storage: economyStorage(value) };
  const result = renderToStaticMarkup(createElement(BoatBlueprints, { state: view, boat: view.boat, config: boatConfig(), now: at, disabled,
    onUpgrade() { assert.fail("Viewing a found fragment cannot spend materials"); }, onInspect() { assert.fail("Viewing an installed telescope cannot request cargo automatically"); } }));
  assert.deepEqual(value, before);
  return result;
}
const imageFragments = html => [...html.matchAll(/background-image:url\(/g)].length;
const craftButtons = html => [...html.matchAll(/<button[^>]*>[^<]*<svg[\s\S]*?<\/svg>Изготовить<\/button>/g)].map(match => match[0]);

test("unfound blueprint fragments render empty recesses without revealing the illustration", () => {
  const html = render(state());
  assert.equal(imageFragments(html), 0);
  assert.doesNotMatch(html, /blueprint-landing-net\.webp|blueprint-telescope\.webp/);
  assert.equal([...html.matchAll(/data-blueprint-fragment=/g)].length, 6);
  assert.match(html, /Первый фрагмент ещё впереди/);
  assert.match(html, /После 1-го зачтённого выхода/);
  assert.match(html, /После 8-го зачтённого выхода/);
  assert.doesNotMatch(html, />Изготовить</);
});

test("found scraps reveal only their share and the next catalog milestone", () => {
  const value = state(); value.boat.blueprints.landing_net = 1; value.boat.qualifiedVoyages = 1; value.boat.completedVoyages = 1;
  const first = render(value);
  assert.equal(imageFragments(first), 1);
  assert.match(first, /blueprint-landing-net\.webp/); assert.doesNotMatch(first, /blueprint-telescope\.webp/);
  assert.match(first, /найдено 1 из 3 фрагментов/); assert.match(first, /После 3-го зачтённого выхода/);
  value.boat.blueprints.landing_net = 2; value.boat.qualifiedVoyages = 3; value.boat.completedVoyages = 3;
  const second = render(value);
  assert.equal(imageFragments(second), 2); assert.match(second, /После 5-го зачтённого выхода/);
  assert.doesNotMatch(second, />Изготовить</);
});

test("a completed picture unlocks normal crafting while missing resources and pending work still block spending", () => {
  const value = state(); value.boat.blueprints.landing_net = 3;
  const ready = render(value);
  assert.equal(imageFragments(ready), 3); assert.match(ready, /изображение собрано/);
  assert.match(ready, /data-complete="true"/);
  const enabled = craftButtons(ready); assert.equal(enabled.length, 1); assert.doesNotMatch(enabled[0], /disabled/);
  value.wallet.coins = 0;
  const blocked = render(value); assert.match(blocked, /Не хватает монет или материалов/);
  assert.match(craftButtons(blocked)[0], /disabled/);
  value.wallet.coins = 100000;
  assert.match(craftButtons(render(value, true))[0], /disabled/);
  value.boat.work = { id: crypto.randomUUID(), upgradeId: "landing_net", startedAt: new Date(at).toISOString(),
    finishesAt: new Date(at + 600000).toISOString(), cost: boatConfig().upgrades.find(entry => entry.id === "landing_net").cost };
  const working = render(value); assert.match(working, /Изготавливаем снаряжение/); assert.match(working, /Работа начата/);
  assert.doesNotMatch(working, />Изготовить</);
});

test("an installed telescope keeps its assembled picture and authentic cargo action without offering duplicate crafting", () => {
  const value = state(); value.boat.blueprints.telescope = 3; value.boat.artifacts = ["telescope"];
  const locked = render(value);
  assert.equal(imageFragments(locked), 3); assert.match(locked, /Изготовлено и установлено на лодке/);
  assert.doesNotMatch(locked, />Изготовить</); assert.match(locked, /Посмотреть будущий груз/);
  assert.match(locked, /Сначала восстановите маяк/);
  value.buildings.lighthouse = 1;
  assert.doesNotMatch(render(value), /Сначала восстановите маяк/);
});

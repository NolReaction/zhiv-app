import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ configFile: false, appType: "custom", root, cacheDir: `/tmp/boat-side-ui-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { BoatArt } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-art.tsx");
const { BoatGarage } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-garage.tsx");
const { BoatModuleThumbnail } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-module-thumbnail.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { newEconomyState } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const html = (component, props) => renderToStaticMarkup(createElement(component, props));
const garageNow = Date.parse("2026-11-09T15:05:00Z");
function garageState() {
  const state = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 3, workshopLevel: 3 });
  state.catalog = economyCatalog; state.wallet.coins = 100000; state.inventory = { planks: 12, rope: 12, hardwood: 3 }; state.buildings.warehouse = 3;
  return state;
}
function renderGarage(state, extra = {}) {
  return html(BoatGarage, { state, boat: state.boat, config: economyCatalog.boat, now: garageNow, disabled: false,
    onUpgrade() { assert.fail("Rendering must not buy an upgrade"); }, onClaim() { assert.fail("Rendering must not claim work"); }, ...extra });
}

test("side-profile BoatArt shows SVG baseline parts with no crate for owned or previewed storage", () => {
  for (const props of [{ repaired: false }, { repaired: true, crate: true }, { repaired: true, previewModule: "crate" }]) {
    const result = html(BoatArt, props);
    assert.match(result, /viewBox="0 185 1000 400"/);
    assert.equal([...result.matchAll(/<image /g)].length, 4);
    assert.doesNotMatch(result, /module-crate|data-boat-part="crate"/);
    assert.match(result, /engine_l0\.svg/); assert.match(result, /tank_l0\.svg/);
    assert.match(result, props.repaired ? /hull_l1\.svg/ : /hull_l0\.svg/);
  }
  const oars = html(BoatArt, { repaired: true, oars: true });
  assert.match(oars, /module-oars\.webp/); assert.doesNotMatch(oars, /engine_l1\.svg/);
  assert.doesNotMatch(oars, /stand-side|data-garage-supports/);
});

test("storage thumbnail uses a capacity symbol without a crate image", () => {
  const result = html(BoatModuleThumbnail, { module: "crate" });
  assert.match(result, /data-boat-capacity-icon/); assert.doesNotMatch(result, /<image|module-crate/);
});

test("garage keeps the storage upgrade rail and bonus but removes its spatial marker and fitting", () => {
  const state = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 3, workshopLevel: 3 });
  state.catalog = economyCatalog; state.boat.level = 1;
  const upgrade = economyCatalog.boat.upgrades.find(entry => entry.id === "crate");
  state.boat.work = { id: "00000000-0000-4000-8000-000000000001", upgradeId: "crate", cost: upgrade.cost,
    startedAt: "2026-11-09T15:00:00Z", finishesAt: "2026-11-09T15:15:00Z" };
  const before = structuredClone(state);
  const result = html(BoatGarage, { state, boat: state.boat, config: economyCatalog.boat,
    now: Date.parse("2026-11-09T15:05:00Z"), disabled: false,
    onUpgrade() { assert.fail("Rendering must not spend materials"); }, onClaim() { assert.fail("Rendering must not claim an upgrade"); } });
  assert.match(result, /data-boat-module="crate"/); assert.match(result, />Трюм</);
  assert.match(result, /data-boat-garage-art/);
  assert.equal([...result.matchAll(/href="\/world\/boat-garage\/stand-side\.svg"/g)].length, 2);
  assert.match(result, /Рыбы за один выход/); assert.match(result, />5</);
  assert.doesNotMatch(result, /Выбрать: Трюм|Примерить модуль|module-crate|data-boat-part="crate"/);
  assert.deepEqual(state, before);
});

test("garage keeps a funded purchase disabled while the economy request is pending", () => {
  const state = garageState(), before = structuredClone(state);
  const enabled = renderGarage(state), pending = renderGarage(state, { disabled: true });
  const buy = result => [...result.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).find(button => button.includes("Восстановить лодку"));
  assert.doesNotMatch(buy(enabled), /disabled=""/);
  assert.match(buy(pending), /disabled=""/);
  assert.equal([...pending.matchAll(/data-boat-module="/g)].length, 3);
  assert.match(pending, /После улучшения/);
  assert.deepEqual(state, before);
});

test("elapsed garage work remains uninstalled until its single claim action is used", () => {
  const state = garageState(), upgrade = economyCatalog.boat.upgrades.find(entry => entry.id === "repair");
  state.boat.work = { id: "00000000-0000-4000-8000-000000000002", upgradeId: "repair", cost: upgrade.cost,
    startedAt: "2026-11-09T15:00:00Z", finishesAt: "2026-11-09T15:10:00Z" };
  const before = structuredClone(state), running = renderGarage(state), ready = renderGarage(state, { now: Date.parse(state.boat.work.finishesAt) });
  assert.doesNotMatch(running, /Завершить работу/);
  assert.equal([...ready.matchAll(/data-boat-work="/g)].length, 1);
  assert.match(ready, /Завершить работу/); assert.match(ready, /Можно установить/);
  const paintedHull = ready.match(/data-boat-part="repair"[^>]*>[\s\S]*?<\/g>/)?.[0];
  assert.match(paintedHull, /hull_l0\.svg/); assert.doesNotMatch(paintedHull, /hull_l1\.svg/);
  assert.deepEqual(state, before);
});

test("legacy artifact work remains claimable outside the three-module garage rail", () => {
  const state = garageState(); state.boat.level = 1;
  const upgrade = economyCatalog.boat.upgrades.find(entry => entry.id === "landing_net");
  state.boat.work = { id: "00000000-0000-4000-8000-000000000003", upgradeId: "landing_net", cost: upgrade.cost,
    startedAt: "2026-11-09T14:00:00Z", finishesAt: "2026-11-09T15:00:00Z" };
  const before = structuredClone(state), result = renderGarage(state);
  assert.equal([...result.matchAll(/data-boat-work="/g)].length, 1);
  assert.match(result, /Завершить работу/);
  assert.doesNotMatch(result, /data-boat-module="(?:landing_net|telescope|engine|fuel)"/);
  assert.deepEqual(state, before);
});

test("garage readiness waits for paid work to be claimed even after the hull is repaired", () => {
  const state = garageState(); state.boat.level = 1;
  const upgrade = economyCatalog.boat.upgrades.find(entry => entry.id === "oars");
  state.boat.work = { id: "00000000-0000-4000-8000-000000000004", upgradeId: "oars", cost: upgrade.cost,
    startedAt: "2026-11-09T15:00:00Z", finishesAt: "2026-11-09T15:10:00Z" };
  const before = structuredClone(state), running = renderGarage(state), ready = renderGarage(state, { now: Date.parse(state.boat.work.finishesAt) });
  assert.match(running, /Улучшение в работе/); assert.match(ready, /Заберите улучшение/);
  for (const result of [running, ready]) assert.doesNotMatch(result, /Готова к воде|data-ready="true"/);
  assert.deepEqual(state, before);
  delete state.boat.work; state.boat.upgrades.push("oars");
  const installed = renderGarage(state);
  assert.match(installed, /Готова к воде/); assert.match(installed, /data-ready="true"/);
});

test("installed garage modules show the current outcome without offering another purchase", () => {
  const state = garageState(); state.boat.level = 1; state.boat.upgrades = ["oars", "crate"];
  const before = structuredClone(state), result = renderGarage(state);
  assert.match(result, /3 \/ 3 улучшений установлено/);
  assert.match(result, /Модуль установлен на лодке/);
  assert.doesNotMatch(result, /Установить улучшение|Восстановить лодку|Примерить модуль|После улучшения/);
  assert.deepEqual(state, before);
});

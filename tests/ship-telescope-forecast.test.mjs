import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-telescope-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { ShipTelescopeForecast } = await vite.ssrLoadModule("/features/economy/ui/ship/ship-telescope-forecast.tsx");
const { WorldShipPort } = await vite.ssrLoadModule("/features/economy/ui/ship/world-ship-port.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { newEconomyState, economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const now = Date.parse("2026-11-02T18:00:00Z");
const navigation = { onNavigateStation() {}, onNavigateExpeditions() {} };
function controller(flags = {}) {
  const value = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 4, workshopLevel: 3 });
  value.buildings.lighthouse = 1;
  value.boat.artifacts = ["telescope"];
  value.ship = { voyage: null, completedVoyages: 0, nextAvailableAt: null };
  return { snapshot: { ...value, ownerPublicId: "telescope-owner", revision: 1, serverTime: new Date(now).toISOString(),
    catalog: economyCatalog, storage: economyStorage(value) }, now, retryAt: 0, busy: false, uncertain: false,
    snapshotConfirmed: true, directActionsAvailable: true, pendingProductionCount: 0,
    act() { assert.fail("A forecast requires an explicit click"); }, retry() {}, ...flags };
}
function elements(tree) {
  const result = [];
  const visit = node => { if (isValidElement(node)) { result.push(node); Children.forEach(node.props.children, visit); } };
  visit(tree); return result;
}
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
function forecastFromPort(economy) {
  let tree;
  function Probe() { tree = WorldShipPort({ economy, ...navigation }); return null; }
  render(Probe);
  return elements(tree).find(node => node.type === ShipTelescopeForecast);
}

test("legacy telescope owners can explicitly inspect from the port once while rendering stays read-only", () => {
  const calls = [], economy = controller({ act(...args) { calls.push(args); return true; } });
  const before = structuredClone(economy.snapshot);
  const html = render(WorldShipPort, { economy, ...navigation });
  assert.match(html, /Посмотреть будущий груз/);
  assert.doesNotMatch(html, /Чертежи|Изготовить|Груз 1/);
  assert.deepEqual(calls, []);
  const forecast = forecastFromPort(economy);
  assert.ok(forecast); assert.equal(forecast.props.disabled, false);
  const button = elements(ShipTelescopeForecast(forecast.props)).find(node => node.type === "button");
  button.props.onClick(); button.props.onClick();
  assert.deepEqual(calls, [["inspect_telescope", "port", 1, 0]]);
  assert.deepEqual(economy.snapshot, before);
  economy.snapshot.boat.artifacts = [];
  assert.doesNotMatch(render(WorldShipPort, { economy, ...navigation }), /Посмотреть будущий груз|data-ship-telescope/);
});

test("unconfirmed, busy, uncertain, queued and cooling accounts cannot inspect even through a retained handler", () => {
  for (const flags of [{ busy: true }, { uncertain: true }, { snapshotConfirmed: false }, { directActionsAvailable: false },
    { pendingProductionCount: 1 }, { retryAt: now + 1000 }]) {
    const economy = controller(flags), forecast = forecastFromPort(economy);
    assert.equal(forecast.props.disabled, true);
    const button = elements(ShipTelescopeForecast(forecast.props)).find(node => node.type === "button");
    assert.equal(button.props.disabled, true);
    button.props.onClick(); forecast.props.onInspect();
  }
  const economy = controller(); economy.snapshot.buildings.lighthouse = 0;
  const tree = ShipTelescopeForecast({ state: economy.snapshot, disabled: false, onInspect() { assert.fail("Lighthouse is required"); } });
  const button = elements(tree).find(node => node.type === "button");
  assert.equal(button.props.disabled, true); button.props.onClick();
});

test("an already saved forecast displays exact server cargo without another command or a blueprint workshop", () => {
  const economy = controller({ uncertain: true });
  const id = crypto.randomUUID();
  economy.snapshot.ship.nextVoyage = { id, number: 3, openedAt: new Date(now).toISOString(), rewardPearls: 20,
    orders: ["Припасы капитана", "Лесной груз", "Запас материалов"].map((title, index) => ({ id: `${id}:${index}`,
      templateId: `forecast-${index}`, title, items: index === 0 ? { rope: 7, planks: 2 } : { wood: index + 1 },
      rewardCoins: 100, deliveredAt: null })) };
  const before = structuredClone(economy.snapshot);
  const html = render(WorldShipPort, { economy, ...navigation });
  assert.match(html, /data-ship-telescope/); assert.match(html, /Груз 1 · Припасы капитана/);
  assert.match(html, /Верёвка/); assert.match(html, /×7/); assert.match(html, /Доска/); assert.match(html, /×2/);
  assert.doesNotMatch(html, /Посмотреть будущий груз|Изготовить|Чертежи/);
  assert.deepEqual(economy.snapshot, before);
  economy.snapshot.boat.artifacts = [];
  assert.doesNotMatch(render(WorldShipPort, { economy, ...navigation }), /Припасы капитана|×7/);
});

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-section-lesson-audit-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { sectionGuideIds, sectionGuideLessons } = await vite.ssrLoadModule("/features/onboarding/section-guide-model.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { WorldPantryMenu, PantrySale } = await vite.ssrLoadModule("/features/economy/ui/inventory/world-pantry-menu.tsx");
const { WorldOrderJournal } = await vite.ssrLoadModule("/features/economy/ui/orders/world-order-journal.tsx");
const { WorldExpeditionSector } = await vite.ssrLoadModule("/features/economy/ui/expeditions/world-expeditions-menu.tsx");
const { WorldProductionSlots } = await vite.ssrLoadModule("/features/economy/ui/production/world-production-slots.tsx");
const { BuilderConversation } = await vite.ssrLoadModule("/features/world/ui/characters/world-builder-dialog.tsx");
const { newTutorialOrder } = await vite.ssrLoadModule("/features/economy/domain/tutorial-order.ts");
const { worldHelpTopics } = await vite.ssrLoadModule("/features/world/ui/help/world-help-content.ts");
const source = async path => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const now = Date.parse("2026-10-16T12:00:00Z");
function controller(patch = {}) {
  const state = { ownerPublicId: "lesson-audit", revision: 1, serverTime: new Date(now).toISOString(), catalog: structuredClone(economyCatalog),
    wallet: { coins: 1000, pearls: 0 }, inventory: { wood: 4, fish_common: 2 }, buildings: { home: 2, warehouse: 1, workshop: 1, woodlot: 1, dryer: 1, quarry: 1, kiln: 1 }, jobs: [], completedExplorations: 0,
    food: { heroMeal: null, builderMeal: null }, ...patch };
  return { snapshot: { ...state, storage: economyStorage(state) }, now, retryAt: 0, busy: false, uncertain: false, error: null, notice: "",
    act() { assert.fail("auditing lessons and their targets must never issue an economy command"); }, retry() {}, refresh() {} };
}
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
const lesson = (section, id) => sectionGuideLessons[section].find(entry => entry.id === id);

test("all seven active sections target attributes still emitted by their current UI", async () => {
  const surfaces = {
    pantry: ["features/economy/ui/inventory/world-pantry-menu.tsx"],
    market: ["features/economy/ui/economy-panel.tsx"],
    plesk: ["features/economy/ui/fishing/plesk-fishing-shop.tsx"],
    orders: ["features/economy/ui/orders/world-order-journal.tsx", "features/economy/ui/orders/world-resident-order-board.tsx"],
    expeditions: ["features/economy/ui/expeditions/world-expeditions-menu.tsx"],
    workshop: ["features/economy/ui/stations/world-object-menu.tsx", "features/economy/ui/production/world-production-card.tsx", "features/economy/ui/production/world-production-slots.tsx"],
    builder: ["features/world/ui/characters/world-builder-dialog.tsx"],
  };
  assert.deepEqual(sectionGuideIds, Object.keys(surfaces));
  for (const [section, files] of Object.entries(surfaces)) {
    const jsx = (await Promise.all(files.map(source))).join("\n");
    for (const step of sectionGuideLessons[section]) for (const selector of step.targets) {
      const attributes = [...selector.matchAll(/\[(data-[\w-]+)(?:="[^"]*")?\]/g)].map(match => match[1]);
      assert.ok(attributes.length, `${section}/${step.id}: target must identify an actual UI marker`);
      for (const attribute of attributes) assert.match(jsx, new RegExp(`\\b${attribute}(?:=|\\s|>)`), `${section}/${step.id}: ${attribute} disappeared from the rendered source`);
    }
  }
  assert.equal(sectionGuideLessons.meals, undefined);
  const copy = Object.values(sectionGuideLessons).flat().map(step => `${step.summary} ${step.text}`).join(" ");
  assert.doesNotMatch(copy, /во вкладке «Еда»|вкладку «Еда»|внизу кладовой|«Все виды»/);
});

test("empty pantry targets real capacity and both sale labels match the ordinary and fish controls", () => {
  const economy = controller({ inventory: {} });
  const empty = render(WorldPantryMenu, { economy, onExplore() {} });
  assert.match(empty, /data-guide-pantry-capacity/);
  for (const id of ["items", "sale"]) assert.ok(lesson("pantry", id).targets.includes("[data-guide-pantry-capacity]"));
  assert.match(lesson("pantry", "items").text, /Уровень и улучшение кладовой находятся в шапке/);
  economy.snapshot.inventory = { wood: 4, fish_common: 2 };
  const ordinary = render(PantrySale, { economy, itemId: "wood" });
  const fish = render(PantrySale, { economy, itemId: "fish_common", fishItemId: "fish_common", compact: true });
  assert.match(ordinary, /Продать торговцу/); assert.match(fish, />Продать · /);
  assert.match(lesson("pantry", "sale").text, /«Продать торговцу», рыбу - «Продать»/);
  assert.match(lesson("pantry", "items").text, /Повторный тап добавит 1.*начнёт с 1/);
  assert.match(lesson("pantry", "market").text, /восстановленный мост/);
});

test("order lesson names the real journal chapters, shared customer filters and permanent request rules", () => {
  const economy = controller();
  economy.snapshot.tutorialOrder = { ...newTutorialOrder(economy.snapshot.catalog), step: 4, completed: true };
  const html = render(WorldOrderJournal, { economy });
  for (const name of ["Путь хозяйства", "Просьбы жителей", "Плёска", "Шишколап"]) {
    assert.ok(html.includes(name), name); assert.ok(lesson("orders", "requirements").text.includes(name), name);
  }
  assert.match(html, /data-order-chapter="progression"/); assert.match(html, /data-order-chapter="repeatable"/);
  assert.match(lesson("orders", "reward").text, /учебные и этапные заменить нельзя/);
  assert.match(lesson("orders", "reward").text, /постройки, завершённые вылазки и ожидание срока/);
  const unavailable = controller(); delete unavailable.snapshot.catalog.food;
  assert.match(render(WorldOrderJournal, { economy: unavailable }), /data-order-journal/);
  assert.ok(lesson("orders", "requirements").targets.includes("[data-order-journal]"));
});

test("travel lesson locates full provisions in preparation and keeps independent mining separate", () => {
  const economy = controller(), common = { economy, state: economy.snapshot, exploring: false, onOpenPantry() {}, onSelectRoute() {}, sectorId: "forest" };
  const routes = render(WorldExpeditionSector, { ...common, selectedRoute: null });
  assert.match(routes, /data-section-guide-target="expedition-routes"/);
  const routeId = routes.match(/data-route="([^"]+)"/)?.[1]; assert.ok(routeId);
  const preparation = render(WorldExpeditionSector, { ...common, selectedRoute: routeId });
  assert.match(preparation, /data-section-guide-target="expedition-preparation"/);
  assert.match(preparation, /Отправиться/);
  assert.match(lesson("expeditions", "routes").text, /время и добыча, а припасы можно проверить в подготовке/);
  assert.match(lesson("expeditions", "routes").text, /Шахта работает в собственной очереди/);
  assert.notEqual(lesson("expeditions", "preparation").revealOnOpen, true);
});

test("workshop queue and builder status anchors belong to the current compact production and conversation", () => {
  const economy = controller();
  assert.match(render(WorldProductionSlots, { economy, stationId: "workshop" }), /data-section-guide-target="workshop-queue"/);
  assert.match(render(BuilderConversation, { economy, onOpenConstruction() {} }), /data-builder-status="free"/);
  assert.match(lesson("workshop", "queue").text, /«Удалить\?» и таймер 5 секунд/);
  assert.match(lesson("builder", "actions").text, /Кнопка «Заказы» откроет журнал с фильтром Шишколапа/);
  assert.match(lesson("builder", "actions").text, /Если строитель занят/);
  for (const section of ["workshop", "builder", "orders", "pantry", "expeditions", "market"]) for (const step of sectionGuideLessons[section]) assert.notEqual(step.revealOnOpen, true, `${section}/${step.id}: explanation must not activate an action`);
});

test("settings and help describe explicit lesson entry without changing the paused-launcher preference", async () => {
  const settings = await source("features/account/profile-settings.tsx");
  assert.match(settings, /Кнопка ручного запуска подсказок/);
  assert.match(settings, /Продолжение приостановленной подсказки доступно и со скрытой кнопкой/);
  assert.match(settings, /checked=\{showSectionGuideLauncher\} onCheckedChange=\{setShowSectionGuideLauncher\}/);
  assert.doesNotMatch(settings, /Новые знакомства.*останутся доступны/);
  const topics = worldHelpTopics(), start = topics.find(entry => entry.id === "start"), plesk = topics.find(entry => entry.id === "plesk");
  assert.match(start.steps[0], /запускает подсказку вручную; при входе она не открывается/);
  assert.match(plesk.steps[2], /в запущенной вами подсказке таблица открывается сама/);
  assert.match(plesk.steps[2], /Открытие не покупает снасть/);
});

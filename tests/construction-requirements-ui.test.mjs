import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "radix-ui";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { ConstructionBuildingArt } = await vite.ssrLoadModule("/features/economy/ui/construction/construction-building-art.tsx");
const { ConstructionRequirements } = await vite.ssrLoadModule("/features/economy/ui/construction/construction-requirements.tsx");
const { WorldStationSetup } = await vite.ssrLoadModule("/features/economy/ui/construction/world-station-setup.tsx");
const { WorldUpgradeContent } = await vite.ssrLoadModule("/features/economy/ui/construction/world-upgrade-dialog.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
after(() => vite.close());

const snapshot = () => ({ catalog: economyCatalog, buildings: { home: 1, warehouse: 1, garden: 1 }, jobs: [],
  inventory: {}, wallet: { coins: 100, pearls: 0 }, storage: { used: 0, capacity: 50 } });
const controller = state => ({ snapshot: state, busy: false, uncertain: false, now: Date.now(), retryAt: 0, act() {} });
const text = html => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
function elements(tree) {
  const found = [];
  function visit(element) {
    if (!isValidElement(element)) return;
    found.push(element); Children.forEach(element.props.children, visit);
  }
  visit(tree); return found;
}

test("building prerequisites have separate named rows, current and target levels and exact navigation", () => {
  const state = snapshot(), opened = [];
  const tree = ConstructionRequirements({ state, required: { home: 2, workshop: 1, garden: 1 },
    navigation: { canOpen: id => id === "workshop", open: id => opened.push(id) } });
  const html = renderToStaticMarkup(tree);
  assert.equal((html.match(/data-building-requirement=/g) ?? []).length, 2);
  assert.doesNotMatch(html, /data-building-requirement="garden"/);
  assert.match(text(html), /Дом Мохлика Сейчас ур\. 1 Нужен ур\. 2/);
  assert.match(text(html), /Мастерская Не построено Нужен ур\. 1/);
  assert.match(html, /data-building-art="home"[^>]*background-image:url\(\/world\/prototype\/home-level-2\.png\)/);
  assert.match(html, /data-building-art="workshop"[^>]*background-image:url\(\/world\/prototype\/forest-workshop-level-1\.png\)/);
  const links = elements(tree).filter(element => element.type === "button");
  assert.equal(links.length, 1, "unavailable destinations remain readable without dead controls");
  links[0].props.onClick();
  assert.deepEqual(opened, ["workshop"]);
  state.buildings.home = 2; state.buildings.workshop = 1;
  assert.equal(ConstructionRequirements({ state, required: { home: 2, workshop: 1, garden: 1 } }), null);
});

test("unbuilt mine lists its building prerequisites separately without production controls", () => {
  const html = renderToStaticMarkup(createElement(WorldStationSetup, { stationId: "quarry", economy: controller(snapshot()), onOpenConstruction() {} }));
  assert.match(html, /data-building-requirement="workshop"/);
  assert.match(html, /data-building-requirement="home"/);
  assert.match(text(html), /Мастерская Не построено Нужен ур\. 1/);
  assert.match(text(html), /Дом Мохлика Сейчас ур\. 1 Нужен ур\. 2/);
  assert.doesNotMatch(html, /production-slot|role="tablist"|data-recipe=/);
});

test("construction help is the final preparation control below missing building levels", () => {
  const html = renderToStaticMarkup(createElement(Dialog.Root, { open: true }, createElement(WorldUpgradeContent, {
    stationId: "quarry", economy: controller(snapshot()), onClose() {}, onOpenHelp() {},
    constructionGoal: { goal: null, pin() {}, clear() {} },
  })));
  const preparation = html.slice(html.indexOf('aria-label="Подготовка к улучшению"'), html.indexOf("</section>", html.indexOf('aria-label="Подготовка к улучшению"')));
  assert.ok(preparation.indexOf("Закрепить цель") < preparation.indexOf('data-building-requirement="home"'));
  assert.ok(preparation.indexOf('data-building-requirement="home"') < preparation.indexOf("Как продолжить?"));
  assert.match(preparation, /Как продолжить\?<\/button>$/);
});


test("campfire building art uses the small cooking fire illustration instead of a cooking pot", () => {
  const html = renderToStaticMarkup(createElement(ConstructionBuildingArt, { stationId: "dryer", level: 1 }));
  assert.match(html, /data-building-art="dryer"/);
  assert.match(html, /data-campfire-icon="true"/);
  assert.doesNotMatch(html, /lucide-cooking-pot/);
  assert.match(html, /viewBox="0 0 64 64"/);
});

test("woodlot requirement art uses its tree fallback after the shelter drawing was removed", () => {
  const html = renderToStaticMarkup(createElement(ConstructionBuildingArt, { stationId: "woodlot", level: 1 }));
  assert.match(html, /data-building-art="woodlot"/);
  assert.match(html, /lucide-trees/);
  assert.doesNotMatch(html, /background-image|shelter\.png|lopukh-house/);
});

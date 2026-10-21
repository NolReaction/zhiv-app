import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "radix-ui";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const cacheDir = await mkdtemp(join(tmpdir(), "zhiv-construction-progress-"));
const hooksId = "virtual:construction-menu-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "construction-menu-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let slots = [], cursor = 0;
      export function reset() { slots = []; cursor = 0; }
      export function render() { cursor = 0; }
      export function useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; }
      export function useState(initial) { const slot = useRef(typeof initial === 'function' ? initial() : initial); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value; }]; }
      export function useId() { return useRef('construction-menu-' + cursor).current; }
      export function useEffect() {}
    `; },
    // Keep the real menu callbacks and state transitions; only React scheduling is adapted.
    transform(source, id) { if (id.endsWith("/features/economy/ui/stations/world-object-menu.tsx")) return source.replace('from "react";', `from "${hooksId}";`); },
  }],
});
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const hooks = await vite.ssrLoadModule(hooksId);
const { WorldObjectMenu } = await vite.ssrLoadModule("/features/economy/ui/stations/world-object-menu.tsx");
const { WorldStationSetup } = await vite.ssrLoadModule("/features/economy/ui/construction/world-station-setup.tsx");
const { WorldUpgradeContent, WorldUpgradeDialog } = await vite.ssrLoadModule("/features/economy/ui/construction/world-upgrade-dialog.tsx");
const { WorldMealBoost } = await vite.ssrLoadModule("/features/economy/ui/food/world-meal-boost.tsx");
const { Work } = await vite.ssrLoadModule("/features/economy/ui/shared/world-economy-parts.tsx");
const { worldPlaceForStation } = await vite.ssrLoadModule("/features/economy/ui/shared/world-stations.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const now = Date.parse("2026-10-18T21:30:00Z");
const dish = economyCatalog.food.meals.find(meal => meal.itemId === "grilled_fish");

function elements(tree) {
  const found = [];
  const visit = element => { if (isValidElement(element)) { found.push(element); Children.forEach(element.props.children, visit); } };
  visit(tree); return found;
}
const text = tree => typeof tree === "string" || typeof tree === "number" ? String(tree)
  : Array.isArray(tree) ? tree.map(text).join("") : isValidElement(tree) ? text(tree.props.children) : "";
const buttons = html => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
  .map(match => ({ attributes: match[1], text: match[2].replace(/<[^>]*>/g, "") }));

function fixture(building, { ready = false, fed = false } = {}) {
  // Home and pantry already exist at first login; other stations also cover their initial construction.
  const target = building.levels.find(level => level.level === (["home", "warehouse"].includes(building.id) ? 2 : 1));
  assert.ok(target, `${building.id} has a real catalog construction level`);
  const job = { id: `construction-${building.id}`, kind: "construction", targetId: building.id, targetLevel: target.level,
    recipeId: null, startedAt: new Date(now - 90_000).toISOString(), finishesAt: new Date(now + (ready ? 0 : 90_000)).toISOString(),
    cost: structuredClone(target.cost), rewards: {}, catalogVersion: economyCatalog.version,
    ...(fed ? { meal: { itemId: dish.itemId, consumer: "builder", speedBps: dish.builderSpeedBps } } : {}) };
  const snapshot = { ownerPublicId: "construction-progress-owner", revision: 4, serverTime: new Date(now).toISOString(), catalog: structuredClone(economyCatalog),
    buildings: { ...Object.fromEntries(economyCatalog.buildings.map(entry => [entry.id, Math.max(...entry.levels.map(level => level.level))])), [building.id]: target.level - 1 },
    wallet: { coins: 10_000, pearls: 10_000 }, inventory: { [dish.itemId]: 2 }, food: { heroMeal: null, builderMeal: null },
    jobs: [job], completedExplorations: 0, migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 } };
  snapshot.storage = economyStorage(snapshot);
  const calls = [];
  const economy = { snapshot, now, busy: false, uncertain: false, retryAt: 0, error: null, act: (...args) => { calls.push(args); return true; }, retry() {} };
  return { job, economy, calls };
}
const upgradeProps = (stationId, economy) => ({ stationId, economy, onClose() {}, isOnline: true,
  navigation: { canOpen: () => true, open() {}, explore() {} } });
function renderUpgrade(stationId, economy) {
  return renderToStaticMarkup(createElement(Dialog.Root, { open: true }, createElement(WorldUpgradeContent, upgradeProps(stationId, economy))));
}
function probe(component, props) {
  let tree;
  function Probe() { tree = component(props); return null; }
  renderToStaticMarkup(createElement(Probe));
  return tree;
}

for (const building of economyCatalog.buildings) {
  for (const ready of [false, true]) for (const fed of [false, true]) {
    test(`${building.id}: ${ready ? "ready" : "active"} construction keeps one timer and completion action ${fed ? "with a saved meal" : "with meal selection"}`, () => {
      const { economy, job, calls } = fixture(building, { ready, fed }), before = structuredClone(economy.snapshot);
      const html = renderUpgrade(building.id, economy), actions = buttons(html);
      assert.equal((html.match(/aria-label="Ход улучшения"/g) ?? []).length, 1);
      assert.equal((html.match(/<progress\b/g) ?? []).length, 1, "a saved job owns one visible progress meter");
      assert.ok(html.includes(`data-job-id="${job.id}"`));
      const claims = actions.filter(action => action.attributes.includes('aria-label="Завершить:'));
      assert.equal(claims.length, 1);
      assert.equal(/\bdisabled=/.test(claims[0].attributes), !ready);
      assert.match(html, ready ? /Готово к получению/ : /1:30/);
      assert.doesNotMatch(html, /Подготовка к улучшению|Начать обустройство|Начать восстановление|Улучшить до ур\./, "paid work never offers another construction debit");
      assert.equal((html.match(/data-meal-boost="builder"/g) ?? []).length, 1);
      if (fed) {
        assert.ok(html.includes(`data-meal-applied="${dish.itemId}"`));
        assert.match(html, /Обед учтён/);
        assert.equal(actions.some(action => action.attributes.includes('data-meal-boost="builder"')), false, "an applied meal is a badge, not a second spending action");
      } else {
        const meal = actions.find(action => action.attributes.includes('data-meal-boost="builder"'));
        assert.ok(meal);
        assert.equal(/\bdisabled=/.test(meal.attributes), ready, "ready work cannot consume another meal");
      }
      assert.equal(html.includes(`data-construction-speedup="${job.id}"`), !ready);
      const nodes = elements(WorldUpgradeContent(upgradeProps(building.id, economy)));
      const boost = nodes.filter(element => element.type === WorldMealBoost);
      assert.equal(boost.length, 1);
      assert.equal(boost[0].props.jobId, job.id, "food accelerates the exact construction that the player opened");
      assert.equal(boost[0].props.consumer, "builder");
      assert.equal(boost[0].props.seconds, undefined, "the saved finish time owns an active meal preview");
      assert.deepEqual(calls, []);
      assert.deepEqual(economy.snapshot, before, "viewing progress never claims, restarts or feeds a job");
    });
  }

  for (const ready of [false, true]) test(`${building.id}: the map menu opens the exact ${ready ? "ready" : "active"} construction without an economic command`, () => {
    const { economy, job, calls } = fixture(building, { ready }), place = worldPlaceForStation(building.id);
    assert.ok(place, `${building.id} is reachable from a map place`);
    const props = { selection: { place, objectId: `${place}.position`, x: 195, y: 380, viewportWidth: 1280, viewportHeight: 900 },
      economy, initialStationId: building.id, isOnline: true, onClose() {} };
    const renderMenu = () => {
      hooks.render();
      const menu = WorldObjectMenu(props);
      return probe(menu.type, menu.props);
    };
    hooks.reset();
    let nodes = elements(renderMenu()), dialog = nodes.find(element => element.type === WorldUpgradeDialog);
    assert.ok(dialog);
    if (building.id === "home") assert.equal(dialog.props.stationId, "home", "home directly opens its upgrade dialog");
    else {
      assert.equal(dialog.props.stationId, null);
      const setup = nodes.find(element => element.type === WorldStationSetup);
      const trigger = setup ? elements(WorldStationSetup(setup.props)).find(element => element.type === "button" && text(element) === "Ход строительства")
        : nodes.find(element => element.type === "button" && element.props["data-guide-station-upgrade"] === building.id);
      assert.ok(trigger, "the actual map progress control is available");
      assert.equal(Boolean(trigger.props.disabled), false);
      const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document"), previousElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
      try {
        Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: null } });
        Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class HTMLElement {} });
        trigger.props.onClick();
      } finally {
        if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document;
        if (previousElement) Object.defineProperty(globalThis, "HTMLElement", previousElement); else delete globalThis.HTMLElement;
      }
      nodes = elements(renderMenu());
      dialog = nodes.find(element => element.type === WorldUpgradeDialog);
      assert.equal(dialog.props.stationId, building.id);
    }
    const opened = elements(WorldUpgradeContent(dialog.props));
    assert.equal(opened.find(element => element.type === Work).props.job.id, job.id);
    assert.equal(opened.find(element => element.type === WorldMealBoost).props.jobId, job.id);
    assert.deepEqual(calls, [], "opening the progress window sends no paid or claim command");
    dialog.props.onClose();
    if (building.id !== "home") assert.equal(elements(renderMenu()).find(element => element.type === WorldUpgradeDialog).props.stationId, null);
  });
}

test("completion requires a ready timer and keeps the exact job and request locks across every building", () => {
  for (const building of economyCatalog.buildings) for (const ready of [false, true]) for (const lock of [{}, { busy: true }, { uncertain: true }, { retryAt: now + 1_000 }]) {
    const { economy, job, calls } = fixture(building, { ready });
    Object.assign(economy, lock);
    const work = elements(WorldUpgradeContent(upgradeProps(building.id, economy))).find(element => element.type === Work);
    const claim = elements(probe(Work, work.props)).find(element => element.type === "button" && element.props["aria-label"]?.startsWith("Завершить:"));
    assert.ok(claim);
    assert.equal(Boolean(claim.props.disabled), !ready || Object.keys(lock).length > 0);
    claim.props.onClick();
    assert.deepEqual(calls, !ready || Object.keys(lock).length ? [] : [["claim_job", job.id]], `${building.id} honors its timer and current request lock`);
  }
});

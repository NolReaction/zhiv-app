import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { WorldExpeditionsMenu, WorldExpeditionSector, ExpeditionRouteDetails, ActiveExpedition, expeditionCancellationKey, expeditionSector, expeditionSectors } = await vite.ssrLoadModule("/features/economy/world-expeditions-menu.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/rules.ts");
after(() => vite.close());

const now = Date.parse("2026-10-03T12:00:00Z");
function snapshot(overrides = {}) {
  const state = { ownerPublicId: "ME", revision: 2, serverTime: new Date(now).toISOString(), wallet: { coins: 0, pearls: 0 }, inventory: {}, buildings: { home: 1, warehouse: 1 }, jobs: [], completedExplorations: 0,
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: structuredClone(economyCatalog), ...overrides };
  return { ...state, storage: overrides.storage ?? economyStorage(state) };
}
function controller(overrides = {}) {
  return { snapshot: snapshot(), market: null, marketError: null, busy: false, uncertain: false, error: null, notice: "", now, retryAt: 0, act() {}, actMarket() {}, refresh() {}, refreshMarket() {}, retry() {}, ...overrides };
}
function job(overrides = {}) {
  return { id: "da818fb4-6c9e-4b42-9b78-60669b234f0a", kind: "exploration", targetId: "forest", recipeId: null, targetLevel: null, startedAt: new Date(now - 1_000).toISOString(), finishesAt: new Date(now + 29_000).toISOString(), rewards: { wood: 5, stone: 3, fiber: 4 }, cost: { coins: 0, items: {} }, catalogVersion: 2, ...overrides };
}
function render(economy = controller(), props = {}) {
  return renderToStaticMarkup(createElement(WorldExpeditionsMenu, { economy, onOpenPantry() {}, ...props }));
}
function renderSector(sectorId, economy = controller(), props = {}) {
  return renderToStaticMarkup(createElement(WorldExpeditionSector, { sectorId, economy, state: economy.snapshot, selectedRoute: null, exploring: economy.snapshot.jobs.some(job => job.kind === "exploration"), onSelectRoute() {}, onOpenPantry() {}, ...props }));
}
function renderPreparation(id, economy = controller(), props = {}) {
  return renderSector(expeditionSector(id), economy, { selectedRoute: id, ...props });
}
function route(html, id) {
  const found = new RegExp(`<(button|section)\\b[^>]*data-route="${id}"[^>]*>`).exec(html);
  assert.ok(found, `Missing route: ${id}`);
  const start = found.index, tag = found[1];
  let depth = 0;
  for (const match of html.slice(start).matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, "g"))) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, start + match.index + match[0].length);
  }
  assert.fail(`Unclosed route: ${id}`);
}
function button(html, label) {
  const found = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ attributes: match[1], text: match[2].replace(/<[^>]*>/g, "") })).find(entry => entry.attributes.includes(`aria-label="${label}"`) || entry.text.includes(label));
  assert.ok(found, `Missing button: ${label}`);
  return found;
}
const disabled = value => /\bdisabled=/.test(value.attributes);

test("expeditions open one sector with accessible controls instead of all ten routes", () => {
  const html = render();
  assert.match(html, /role="group" aria-label="Секторы вылазок"/);
  assert.match(html, /data-sector-select="forest" aria-pressed="true"/);
  for (const id of ["shore", "caves"]) assert.match(html, new RegExp(`data-sector-select="${id}" aria-pressed="false"`));
  assert.match(html, /data-sector="forest"/);
  assert.doesNotMatch(html, /data-route="(?:shore|cave|deep_cave)"/);
  assert.equal([...html.matchAll(/<button\b[^>]*data-route=/g)].length, 4);
  assert.doesNotMatch(html, /<select\b|<details\b|aria-label="Отправиться:/);
  assert.ok(html.indexOf('data-route="forest"') < html.indexOf('data-route="old_woodland"'));
  assert.match(html, /Доступные маршруты/);
  assert.match(html, /Нужно подготовиться/);
  assert.doesNotMatch(html, /role="dialog"|role="tablist"|Кошелёк|<h[123][^>]*>Обзор|Продать|Производство/);
  assert.equal(disabled(button(route(html, "forest"), "Подготовиться: Лесная разведка")), false);
});

test("every catalog route belongs to exactly one sector and keeps its actual findings", () => {
  const expected = { forest: ["forest", "forest_camp", "old_woodland", "uplands"], shore: ["shore", "shore_camp", "coastal_deposits"], caves: ["cave", "deep_cave", "abandoned_quarry", "quarry_stone", "quarry_stone_overnight", "quarry_ore", "quarry_clay", "quarry_sand", "quarry_shift", "quarry_deep_face", "quarry_supply"] };
  const seen = [];
  for (const sector of expeditionSectors) {
    const html = renderSector(sector.id);
    const ids = [...html.matchAll(/data-route="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(ids, expected[sector.id]);
    seen.push(...ids);
    for (const id of ids) {
      const entry = economyCatalog.explorations.find(route => route.id === id);
      assert.equal(expeditionSector(id), sector.id);
      const content = route(html, id);
      assert.match(content, /<button\b/);
      assert.match(content, /aria-label="Подготовиться:/);
      assert.doesNotMatch(content, /<details\b|<select\b/);
      for (const [itemId, count] of Object.entries(entry.rewards)) {
        const name = itemId === "fish" && economyCatalog.fishing.routeIds.includes(id)
          ? "Рыбный улов" : economyCatalog.items.find(item => item.id === itemId).name;
        assert.ok(content.includes(name));
        assert.ok(content.includes(`×${count}`));
      }
      assert.ok(!content.includes(entry.description), "descriptive prose should not obscure route choices");
    }
  }
  assert.deepEqual(seen.sort(), economyCatalog.explorations.map(route => route.id).sort());
});

test("the fisherman's shortcut opens the shore sector without changing route conditions", () => {
  const html = render(controller(), { initialSector: "shore" });
  assert.match(html, /data-sector-select="shore" aria-pressed="true"/);
  assert.match(html, /data-sector="shore"/);
  assert.doesNotMatch(html, /data-sector="forest"/);
  const shore = route(html, "shore");
  assert.match(shore, /Рыбалка на берегу/);
  assert.equal(disabled(button(shore, "Подготовиться: Рыбалка на берегу")), false);
});

test("selected route replaces the list with one preparation screen and a return action", () => {
  const html = renderPreparation("shore");
  assert.match(route(html, "shore"), /data-route-preparation="true"/);
  assert.doesNotMatch(html, /data-route="shore_camp"|data-route="coastal_deposits"|Подготовиться:/);
  assert.equal([...html.matchAll(/<select\b/g)].length, 3);
  assert.equal([...html.matchAll(/aria-label="Отправиться:/g)].length, 1);
  assert.equal(disabled(button(html, "Все маршруты")), false);
  assert.match(html, /Улов за одну вылазку/);
  assert.match(route(renderSector("shore"), "shore_camp"), /data-compact="true"/);
});

test("locked routes explain all missing buildings and offer navigation only when supplied", () => {
  const html = route(renderPreparation("old_woodland", controller(), { onNavigateStation() {} }), "old_woodland");
  assert.match(html, /Условия открытия/);
  assert.match(html, /нужен ур\. 3/);
  assert.match(html, /нужен ур\. 2/);
  assert.equal(disabled(button(html, "Отправиться")), true);
  assert.equal(disabled(button(html, "нужен ур. 3")), false);
  const withoutNavigation = route(renderPreparation("old_woodland"), "old_woodland");
  assert.match(withoutNavigation, /<span>[^<]+ · нужен ур\. 3<\/span>/);
});

test("cave preparation explains the unbuilt quarry and guards departure until it is completed", () => {
  for (const id of ["cave", "deep_cave"]) {
    const state = snapshot({ buildings: { home: 3, warehouse: 5, quarry: 0 },
      inventory: { dried_berries: 1, smoked_fish: 1 } });
    const locked = sectorView("caves", state, {}, { selectedRoute: id, onNavigateStation() {} });
    assert.ok(locked.html.includes(`${economyCatalog.buildings.find(building => building.id === "quarry").name} · нужен ур. 1`));
    const depart = locked.depart(id);
    assert.ok(depart);
    assert.equal(depart.props.disabled, true);
    depart.props.onClick();
    assert.deepEqual(locked.calls, [], "calling a disabled handler cannot send a start command");
    state.buildings.quarry = 1;
    const open = sectorView("caves", state, {}, { selectedRoute: id });
    assert.equal(open.depart(id).props.disabled, false);
    open.depart(id).props.onClick();
    assert.equal(open.calls.length, 1);
    state.jobs = [job({ kind: "construction", targetId: "quarry", targetLevel: 2, rewards: {} })];
    const upgrading = sectorView("caves", state, {}, { selectedRoute: id });
    assert.equal(upgrading.depart(id).props.disabled, true);
    upgrading.depart(id).props.onClick();
    assert.deepEqual(upgrading.calls, []);
  }
});

test("deep routes use actual consumable amounts, and missing provisions block departure", () => {
  const state = snapshot({ buildings: { home: 3, warehouse: 1, quarry: 1 }, inventory: { dried_berries: 1 } });
  let html = route(renderPreparation("deep_cave", controller({ snapshot: state })), "deep_cave");
  assert.match(html, /Припасы для вылазки/);
  assert.match(html, /Не хватает припасов/);
  assert.equal(disabled(button(html, "Отправиться")), true);
  html = route(renderPreparation("deep_cave", controller({ snapshot: snapshot({ ...state, inventory: { dried_berries: 1, smoked_fish: 1 } }) })), "deep_cave");
  assert.equal(disabled(button(html, "Отправиться")), false);
});

test("departure compares reward size with total capacity; a full pantry can be cleared before return", () => {
  let state = snapshot({ storage: { capacity: 10, available: 10, used: 0, reserved: 0, overflow: 0 } });
  let html = route(renderPreparation("forest", controller({ snapshot: state })), "forest");
  assert.equal(disabled(button(html, "Отправиться")), true);
  assert.match(html, /Находки займут 12 мест, вместимость — 10/);
  assert.equal(disabled(button(html, "Расширить кладовую")), false);
  state = snapshot({ storage: { capacity: 200, available: 0, used: 170, reserved: 30, overflow: 0 } });
  html = route(renderPreparation("forest", controller({ snapshot: state })), "forest");
  assert.equal(disabled(button(html, "Отправиться")), false);
  assert.match(html, /свободно 0/);
});

test("ongoing exploration shows real progress and seconds, and exposes no second departure", () => {
  const html = render(controller({ snapshot: snapshot({ jobs: [job()] }) }));
  assert.match(html, /Текущая вылазка: Лесная разведка/);
  assert.match(html, /Ещё 29 с/);
  assert.match(html, /<progress[^>]*value="0\.033/);
  assert.equal(disabled(button(html, "Забрать находки: Лесная разведка")), true);
  assert.doesNotMatch(html, /aria-label="Отправиться:/);
  assert.ok(html.indexOf("Текущая вылазка") < html.indexOf("Секторы вылазок"));
});

test("an active route from another sector stays above the sector picker", () => {
  const html = render(controller({ snapshot: snapshot({ jobs: [job({ targetId: "deep_cave", rewards: { stone: 30, ore: 20 } })] }) }));
  assert.match(html, /Текущая вылазка: Глубокий проход/);
  assert.match(html, /data-sector="forest"/);
  assert.ok(html.indexOf("Текущая вылазка") < html.indexOf("Секторы вылазок"));
  assert.doesNotMatch(html, /aria-label="Отправиться:/);
});

test("ready finds honor available space including market reservations and retain an accessible pantry action", () => {
  const ready = job({ finishesAt: new Date(now).toISOString() });
  let html = render(controller({ snapshot: snapshot({ jobs: [ready], storage: { capacity: 200, used: 180, reserved: 15, available: 5, overflow: 0 } }) }));
  assert.match(html, /Мохлик вернулся/);
  assert.match(html, /Нужно освободить 7 мест/);
  assert.equal(disabled(button(html, "Забрать находки: Лесная разведка")), true);
  assert.equal(disabled(button(html, "Открыть кладовую")), false);
  html = render(controller({ snapshot: snapshot({ jobs: [ready] }) }));
  assert.equal(disabled(button(html, "Забрать находки: Лесная разведка")), false);
});

test("construction and production do not hide exploration or occupy the explorer", () => {
  const html = renderPreparation("forest", controller({ snapshot: snapshot({ jobs: [job({ kind: "construction", targetId: "home", rewards: {}, targetLevel: 2 }), job({ kind: "production", targetId: "garden", recipeId: "grow_berries", rewards: { berries: 6 } })] }) }));
  assert.doesNotMatch(html, /Текущая вылазка|Мохлик занят|Мохлик в пути/);
  assert.equal(disabled(button(route(html, "forest"), "Отправиться")), false);
});

test("quarry work blocks all departures and gives a way to claim its result", () => {
  for (const finished of [false, true]) {
    const saved = job({ kind: "production", targetId: "quarry", recipeId: "quarry_stone", finishesAt: new Date(now + (finished ? 0 : 30_000)).toISOString() });
    const economy = controller({ snapshot: snapshot({ jobs: [saved], buildings: { home: 3, warehouse: 1 } }) });
    const html = render(economy, { onNavigateStation() {} });
    assert.match(html, finished ? /Сначала заберите добычу из каменоломни/ : /Мохлик работает в каменоломне/);
    assert.equal(disabled(button(html, "Открыть каменоломню")), false);
    for (const [sector, id] of [["forest", "forest"], ["shore", "shore"], ["caves", "cave"]]) {
      const content = route(renderSector(sector, economy, { selectedRoute: id }), id);
      assert.equal(disabled(button(content, "Отправиться")), true);
    }
    assert.doesNotMatch(html, /Можно отправиться/);
  }
});

test("the caves control opens the shared mine when map navigation is supplied", () => {
  let tree, opened = 0;
  function Probe() { tree = WorldExpeditionsMenu({ economy: controller(), onOpenPantry() {}, onOpenQuarry() { opened++; } }); return tree; }
  renderToStaticMarkup(createElement(Probe));
  let caves;
  function walk(element) {
    if (!isValidElement(element)) return;
    if (element.props["data-sector-select"] === "caves") caves = element;
    Children.forEach(element.props.children, walk);
  }
  walk(tree);
  assert.ok(caves); caves.props.onClick();
  assert.equal(opened, 1);
  const embedded = render(controller(), { embeddedCaves: true });
  assert.match(embedded, /data-sector="caves"/);
  assert.doesNotMatch(embedded, /Секторы вылазок|data-sector="forest"|data-sector="shore"/);
});

test("busy, uncertain and cooldown states prevent both spending and reward claims", () => {
  for (const flags of [{ busy: true }, { uncertain: true }, { retryAt: now + 5_000 }]) {
    assert.equal(disabled(button(route(renderPreparation("forest", controller(flags)), "forest"), "Отправиться")), true);
    const html = render(controller({ ...flags, snapshot: snapshot({ jobs: [job({ finishesAt: new Date(now).toISOString() })] }) }));
    assert.equal(disabled(button(html, "Забрать находки: Лесная разведка")), true);
  }
  assert.match(render(controller({ uncertain: true })), /Проверить результат/);
  assert.equal(disabled(button(render(controller({ retryAt: now + 5_000 })), "Повторить через 5 с")), true);
});

test("initial loading and failure have no fabricated routes; unrelated DEV notices stay out", () => {
  let html = render(controller({ snapshot: null }));
  assert.match(html, /Открываем маршруты/);
  assert.doesNotMatch(html, /data-route|Отправиться/);
  html = render(controller({ snapshot: null, error: "Связь потеряна" }));
  assert.match(html, /Связь потеряна/);
  assert.equal(disabled(button(html, "Попробовать ещё раз")), false);
  html = render(controller({ notice: "Выдано 10000 монет в DEV" }));
  assert.doesNotMatch(html, /Выдано 10000/);
});

function activeView(savedJob = job(), options = {}) {
  const calls = [], confirmations = [], cancellations = [];
  const state = options.state ?? snapshot({ jobs: [savedJob] });
  const economy = controller({ snapshot: state, act: (...args) => calls.push(args), ...options.economy });
  const key = expeditionCancellationKey(state.ownerPublicId, savedJob);
  const props = { economy, state, job: savedJob, onOpenPantry() {},
    confirmationKey: options.confirmed ? key : options.confirmationKey ?? null,
    onConfirmation: value => confirmations.push(value), onCancellationSent: value => cancellations.push(value) };
  let tree;
  function Probe() { tree = ActiveExpedition(props); return tree; }
  const html = renderToStaticMarkup(createElement(Probe));
  const elements = [];
  function walk(element) {
    if (!isValidElement(element)) return;
    elements.push(element); Children.forEach(element.props.children, walk);
  }
  walk(tree);
  const control = label => elements.find(element => element.type === "button"
    && (element.props["aria-label"] === label || Children.toArray(element.props.children).filter(child => typeof child === "string").join("") === label));
  return { html, elements, control, calls, confirmations, cancellations, props, key };
}

test("recall requires a second explicit decision and never removes a job optimistically", () => {
  const saved = job({ targetId: "shore", rewards: { fish: 4 } });
  const first = activeView(saved);
  assert.doesNotMatch(first.html, /Вернуться без добычи|Все награды этой вылазки/);
  first.control("Вернуть Мохлика").props.onClick();
  assert.deepEqual(first.confirmations, [first.key]);
  assert.deepEqual(first.calls, []);
  const confirm = activeView(saved, { confirmationKey: first.key });
  assert.match(confirm.html, /Все награды этой вылазки будут потеряны/);
  assert.match(confirm.html, /role="group" aria-labelledby="[^"]+" aria-describedby="[^"]+"/);
  assert.ok(confirm.html.indexOf("Продолжить вылазку") < confirm.html.indexOf("Вернуться без добычи"), "safe action is first in tab order");
  const discard = confirm.control("Вернуться без добычи");
  assert.equal(discard.props.disabled, false);
  discard.props.onClick(); discard.props.onClick();
  assert.deepEqual(confirm.calls, [["cancel_exploration", saved.id]], "double clicking cannot issue another cancellation");
  assert.deepEqual(confirm.cancellations, [saved.id]);
  assert.deepEqual(confirm.confirmations, [null]);
  assert.equal(confirm.props.state.jobs[0], saved, "the card uses the confirmed snapshot until the response arrives");
  assert.deepEqual(confirm.props.state.inventory, {});
});

test("continuing a paid expedition sends no command and explains already-spent supplies", () => {
  const view = activeView(job({ targetId: "deep_cave", cost: { coins: 7, items: { smoked_fish: 1 } } }), { confirmed: true });
  assert.match(view.html, /Потраченные монеты и припасы не возвращаются/);
  view.control("Продолжить вылазку").props.onClick();
  assert.deepEqual(view.confirmations, [null]);
  assert.deepEqual(view.calls, []); assert.deepEqual(view.cancellations, []);
});

test("unclaimed ready finds can be discarded without a claim, even if the pantry is full", () => {
  const ready = job({ finishesAt: new Date(now).toISOString() });
  const state = snapshot({ jobs: [ready], storage: { capacity: 200, used: 200, reserved: 0, available: 0, overflow: 0 } });
  const first = activeView(ready, { state });
  assert.equal(first.control("Отказаться от находок").props.disabled, false);
  const view = activeView(ready, { state, confirmed: true });
  assert.match(view.html, /Отказаться от этой добычи/);
  assert.ok(view.control("Оставить находки"));
  const claim = view.control("Забрать находки: Лесная разведка");
  assert.equal(claim.props.disabled, true); claim.props.onClick();
  view.control("Вернуться без добычи").props.onClick();
  assert.deepEqual(view.calls, [["cancel_exploration", ready.id]]);
});

test("busy, uncertain, cooldown and stale snapshots block both recall steps and handler dispatch", () => {
  const saved = job();
  for (const flags of [{ busy: true }, { uncertain: true }, { retryAt: now + 5000 },
    { snapshot: snapshot({ jobs: [] }) }, { snapshot: snapshot({ ownerPublicId: "OTHER", jobs: [saved] }) }]) {
    const view = activeView(saved, { confirmed: true, economy: flags });
    const recall = view.control("Вернуть Мохлика"), confirm = view.control("Вернуться без добычи");
    assert.equal(recall.props.disabled, true); assert.equal(confirm.props.disabled, true);
    recall.props.onClick(); confirm.props.onClick();
    assert.deepEqual(view.calls, []); assert.deepEqual(view.confirmations, []);
    const keep = view.control("Продолжить вылазку");
    assert.notEqual(keep.props.disabled, true); keep.props.onClick();
    assert.deepEqual(view.confirmations, [null], "backing out remains possible while the receipt is being checked");
  }
});

test("cancellation approval is scoped to the exact job and owner, while timer ticks preserve it", () => {
  const original = job(), key = expeditionCancellationKey("ME", original);
  for (const changed of [job({ id: crypto.randomUUID() }), job({ targetId: "shore" }),
    job({ finishesAt: new Date(now + 31_000).toISOString() }), job({ rewards: { fish: 40 } }),
    job({ cost: { coins: 3, items: {} } })]) {
    const view = activeView(changed, { confirmationKey: key });
    assert.doesNotMatch(view.html, /Вернуться без добычи/);
    assert.equal(view.control("Вернуть Мохлика").props["aria-expanded"], false);
  }
  const other = activeView(original, { confirmationKey: key, state: snapshot({ ownerPublicId: "OTHER", jobs: [original] }) });
  assert.doesNotMatch(other.html, /Вернуться без добычи/);
  const tick = activeView(original, { confirmationKey: key, economy: { now: now + 1000 } });
  assert.match(tick.html, /Вернуться без добычи/);
  assert.equal(tick.control("Вернуть Мохлика").props["aria-expanded"], true);
  assert.equal(expeditionCancellationKey("ME", job({ rewards: { fiber: 4, wood: 5, stone: 3 } })), key,
    "map key ordering does not create a different job approval");
});

function sectorView(sectorId, state, overrides = {}, props = {}) {
  const calls = [], visits = [], selections = [], elements = [];
  const economy = controller({ snapshot: state, act: (...args) => calls.push(args), ...overrides });
  let tree;
  function Probe() {
    tree = WorldExpeditionSector({ sectorId, selectedRoute: null, onSelectRoute: id => selections.push(id), economy, state,
      exploring: state.jobs.some(entry => entry.kind === "exploration"), onOpenPantry() {},
      onOpenFishingShop: () => visits.push("plesk"), ...props });
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Probe));
  function walk(element) {
    if (!isValidElement(element)) return;
    elements.push(element);
    // Render the real route component under React so its equipment/receipt hooks
    // and handlers are inspected without reimplementing departure decisions.
    if (element.type === ExpeditionRouteDetails) {
      function Probe() { const detail = ExpeditionRouteDetails(element.props); walk(detail); return detail; }
      renderToStaticMarkup(createElement(Probe));
    }
    Children.forEach(element.props.children, walk);
  }
  walk(tree);
  const depart = routeId => elements.find(element => element.type === "button"
    && element.props["aria-label"] === `Отправиться: ${state.catalog.explorations.find(entry => entry.id === routeId).name}`);
  return { html, elements, calls, visits, selections, depart };
}
const fishingGear = (overrides = {}) => ({ ownedRods: ["reed_rod", "river_rod", "willow_rod"], equippedRodId: "willow_rod",
  equippedBaitId: "worm_bait", catches: {}, ...overrides });

test("route selection and return only navigate, with no hidden departure forms in the list", () => {
  const state = snapshot();
  const list = sectorView("shore", state);
  const card = list.elements.find(element => element.type === "button" && element.props["data-route"] === "shore");
  assert.ok(card);
  assert.notEqual(card.props.disabled, true);
  assert.equal(list.elements.filter(element => element.type === ExpeditionRouteDetails).length, 0);
  assert.doesNotMatch(list.html, /<select\b|aria-label="Отправиться:/);
  card.props.onClick();
  assert.deepEqual(list.selections, ["shore"]);
  assert.deepEqual(list.calls, []);
  const preparation = sectorView("shore", state, {}, { selectedRoute: list.selections[0] });
  assert.equal(preparation.elements.filter(element => element.type === ExpeditionRouteDetails).length, 1);
  const back = preparation.elements.find(element => element.type === "button"
    && Children.toArray(element.props.children).some(child => child === "Все маршруты"));
  assert.ok(back); back.props.onClick();
  assert.deepEqual(preparation.selections, [null]);
  assert.deepEqual(preparation.calls, []);
  const returned = sectorView("shore", state, {}, { selectedRoute: preparation.selections[0] });
  assert.doesNotMatch(returned.html, /<select\b|aria-label="Отправиться:/);
  assert.match(returned.html, /data-route="shore_camp"/);
});

test("route cards describe their duration, rewards and preparation reason beyond their accessible name", () => {
  const view = sectorView("forest", snapshot());
  const card = view.elements.find(element => element.type === "button" && element.props["data-route"] === "old_woodland");
  const descriptionIds = card.props["aria-describedby"]?.trim().split(/\s+/);
  assert.ok(descriptionIds?.length, "the route name alone omits information needed to compare trips");
  const description = descriptionIds.map(id => {
    const target = view.elements.find(element => element.props.id === id);
    assert.ok(target, `Missing description target: ${id}`);
    return renderToStaticMarkup(target).replace(/<[^>]*>/g, " ");
  }).join(" ");
  assert.match(description, /8 ч/);
  assert.match(description, /ур\. 1 \+2/);
  const catalogRoute = economyCatalog.explorations.find(entry => entry.id === "old_woodland");
  for (const [id, count] of Object.entries(catalogRoute.rewards)) {
    assert.ok(description.includes(economyCatalog.items.find(item => item.id === id).name));
    assert.match(description, new RegExp(`×\\s*${count}`));
  }
});

test("closed fishing details leave catch guarantees, missing supplies and departure visible", () => {
  const view = sectorView("shore", snapshot({ fishing: fishingGear(), inventory: {} }), {}, { selectedRoute: "shore" });
  const collapsed = view.elements.filter(element => element.type === "details");
  for (const label of ["Снасти для вылазки", "Шансы улова"]) {
    const details = collapsed.find(element => element.props["aria-label"] === label);
    assert.ok(details, label);
    assert.notEqual(details.props.open, true);
  }
  let depth = 0, visible = "", previous = 0;
  for (const match of view.html.matchAll(/<\/?details\b[^>]*>/g)) {
    if (depth === 0) visible += view.html.slice(previous, match.index);
    depth += match[0].startsWith("</") ? -1 : 1;
    previous = match.index + match[0].length;
  }
  assert.equal(depth, 0);
  visible += view.html.slice(previous);
  assert.match(visible, /Улов за одну вылазку/);
  assert.match(visible, /Всего рыб/); assert.match(visible, /Речных гарантировано/);
  assert.match(visible, /Попыток особого улова/); assert.match(visible, /Наживки за поход/);
  assert.match(visible, /Не хватает припасов/);
  assert.equal(disabled(button(visible, "Отправиться")), true);
  assert.doesNotMatch(visible, /<select\b/);
});

test("stale selections cannot prepare another sector or a route superseded by mine upgrades", () => {
  for (const selectedRoute of ["shore", "missing_route"]) {
    const view = sectorView("forest", snapshot(), {}, { selectedRoute });
    assert.doesNotMatch(view.html, /data-route-preparation="true"|<select\b|aria-label="Отправиться:/);
    assert.match(view.html, /data-route="forest"/);
    assert.deepEqual(view.calls, []);
  }
  const state = snapshot({ buildings: { home: 5, warehouse: 5, quarry: 5 } });
  for (const selectedRoute of ["quarry_shift", "quarry_deep_face"]) {
    const view = sectorView("caves", state, {}, { selectedRoute });
    assert.doesNotMatch(view.html, /data-route-preparation="true"|aria-label="Отправиться:/);
    assert.match(view.html, /data-route="quarry_supply"/);
  }
});

test("a selected route cannot start while an exploration or a mine upgrade is still active", () => {
  const exploring = sectorView("shore", snapshot({ jobs: [job()] }), {}, { selectedRoute: "shore" });
  assert.match(exploring.html, /Сначала заберите находки или отмените текущую вылазку/);
  assert.equal(exploring.depart("shore"), undefined);
  assert.deepEqual(exploring.calls, []);
  const mining = sectorView("caves", snapshot({ buildings: { home: 3, warehouse: 3, quarry: 2 }, jobs: [job({ kind: "construction", targetId: "quarry", rewards: {}, targetLevel: 3 })] }), {}, { selectedRoute: "quarry_stone" });
  assert.match(mining.html, /Дождитесь улучшения шахты/);
  assert.equal(mining.depart("quarry_stone").props.disabled, true);
  mining.depart("quarry_stone").props.onClick();
  assert.deepEqual(mining.calls, []);
});

test("fishing departure shows equipped gear, charges one bait per trip and guards a missing-bait handler", () => {
  const state = snapshot({ fishing: fishingGear(), inventory: {} });
  const before = structuredClone(state);
  const missing = sectorView("shore", state, {}, { selectedRoute: "shore" });
  const shore = route(missing.html, "shore");
  assert.match(shore, /Ивовая удочка/); assert.match(shore, /Наживки за поход/);
  assert.match(shore, /Не хватает припасов/); assert.match(shore, /<strong>0 \/ 1<\/strong>/);
  assert.equal(missing.depart("shore").props.disabled, true);
  missing.depart("shore").props.onClick(); assert.deepEqual(missing.calls, []);
  const ready = sectorView("shore", snapshot({ ...state, inventory: { worm_bait: 1 } }), {}, { selectedRoute: "shore" });
  assert.equal(ready.depart("shore").props.disabled, false);
  ready.depart("shore").props.onClick(); assert.deepEqual(ready.calls, [["start_fishing", "shore", 1, 0]]);
  assert.deepEqual(state, before, "rendering and choosing a trip cannot deduct supplies optimistically");
  const bare = sectorView("shore", snapshot({ fishing: fishingGear({ equippedBaitId: null }), inventory: {} }), {}, { selectedRoute: "shore" });
  assert.match(route(bare.html, "shore"), /Без наживки/);
  assert.equal(bare.depart("shore").props.disabled, false);
});

test("fishing consumes the dedicated action only for declared routes and preserves legacy-backend departures", () => {
  const state = snapshot({ buildings: Object.fromEntries(economyCatalog.buildings.map(building => [building.id, 5])),
    inventory: { worm_bait: 1, smoked_fish: 3, dried_berries: 3 }, fishing: fishingGear() });
  for (const routeId of ["shore", "shore_camp", "coastal_deposits", "forest"]) {
    const view = sectorView(expeditionSector(routeId), state, {}, { selectedRoute: routeId });
    assert.equal(view.depart(routeId).props.disabled, false);
    view.depart(routeId).props.onClick();
    assert.deepEqual(view.calls, [[economyCatalog.fishing.routeIds.includes(routeId) ? "start_fishing" : "start_exploration", routeId, 1, 0]]);
  }
  const legacy = structuredClone(state); delete legacy.catalog.fishing; delete legacy.fishing;
  const fallback = sectorView("shore", legacy, {}, { selectedRoute: "shore" }); fallback.depart("shore").props.onClick();
  assert.deepEqual(fallback.calls, [["start_exploration", "shore", 1, 0]]);
  assert.doesNotMatch(route(fallback.html, "shore"), /Рыбный улов|Купить снасти/);
  assert.match(route(fallback.html, "shore"), new RegExp(economyCatalog.items.find(item => item.id === "fish").name));
  for (const flags of [{ busy: true }, { uncertain: true }, { retryAt: now + 1000 }]) {
    const locked = sectorView("shore", state, flags, { selectedRoute: "shore" });
    assert.equal(locked.depart("shore").props.disabled, true);
    locked.depart("shore").props.onClick(); assert.deepEqual(locked.calls, []);
  }
});

test("shore gear shortcuts open Pleska without spending and fishing keeps each route's advertised capacity", () => {
  const view = sectorView("shore", snapshot(), {}, { selectedRoute: "shore" });
  const shops = view.elements.filter(element => element.type === "button"
    && Children.toArray(element.props.children).some(child => child === "Купить снасти у Плёски"));
  assert.equal(shops.length, 1);
  shops[0].props.onClick(); assert.deepEqual(view.visits, ["plesk"]); assert.deepEqual(view.calls, []);
  const without = sectorView("shore", snapshot(), {}, { selectedRoute: "shore", onOpenFishingShop: undefined });
  assert.doesNotMatch(without.html, /Купить снасти у Плёски/);
  for (const routeId of economyCatalog.fishing.routeIds) {
    const entry = economyCatalog.explorations.find(route => route.id === routeId);
    const quantity = Object.values(entry.rewards).reduce((sum, count) => sum + count, 0);
    const full = sectorView("shore", snapshot({ storage: { capacity: quantity - 1, available: quantity - 1, used: 0, reserved: 0, overflow: 0 } }), {}, { selectedRoute: routeId });
    assert.equal(full.depart(routeId).props.disabled, true);
    assert.match(route(full.html, routeId), new RegExp(`Находки займут ${quantity} мест`));
    assert.match(route(full.html, routeId), /Всего рыб/);
    assert.match(route(full.html, routeId), new RegExp(`<dd>${entry.rewards.fish}</dd>`));
  }
});

test("an active fishing job shows its saved species and forfeits the exact result and bait on cancellation", () => {
  const saved = job({ targetId: "shore", rewards: { fish: 3, fish_mooncarp: 1 }, cost: { coins: 0, items: { worm_bait: 1 } },
    fishing: { rodId: "willow_rod", baitId: "worm_bait", fishId: "fish_mooncarp" } });
  const state = snapshot({ jobs: [saved], fishing: fishingGear({ equippedRodId: "reed_rod", equippedBaitId: null }) });
  const view = activeView(saved, { state, confirmed: true });
  assert.doesNotMatch(view.html, /Рыбный улов/);
  for (const fishId of ["fish", "fish_mooncarp"]) assert.match(view.html, new RegExp(economyCatalog.items.find(item => item.id === fishId).name));
  assert.match(view.html, /×3/); assert.match(view.html, /×1/);
  assert.match(view.html, /Потраченные монеты и припасы не возвращаются/);
  view.control("Вернуться без добычи").props.onClick();
  assert.deepEqual(view.calls, [["cancel_exploration", saved.id]]);
  assert.deepEqual(state.jobs[0].rewards, { fish: 3, fish_mooncarp: 1 }); assert.deepEqual(state.inventory, {});
  const changed = { ...saved, fishing: { ...saved.fishing, rodId: "river_rod" } };
  assert.notEqual(expeditionCancellationKey(state.ownerPublicId, changed), view.key,
    "a cancellation confirmation cannot survive replacement of a saved fishing result");
});

function fishingDepartureView(state = snapshot(), overrides = {}) {
  const calls = [], elements = [];
  const economy = controller({ snapshot: state, act(...args) { calls.push(args); }, ...overrides });
  let tree;
  function Probe() {
    tree = ExpeditionRouteDetails({ state, economy, route: state.catalog.explorations.find(route => route.id === "shore"), exploring: false, onOpenPantry() {} });
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Probe));
  function walk(element) { if (!isValidElement(element)) return; elements.push(element); Children.forEach(element.props.children, walk); }
  walk(tree);
  const [rod, hook, bait] = elements.filter(element => element.type === "select");
  const start = elements.find(element => element.type === "button" && element.props["aria-label"]?.startsWith("Отправиться:"));
  return { calls, html, rod, hook, bait, start, elements };
}

test("departure offers only owned rods and allows bait from stock or explicitly no bait", () => {
  const state = snapshot({ fishing: fishingGear({ ownedRods: ["reed_rod", "river_rod"], equippedRodId: "reed_rod" }), inventory: { worm_bait: 2 } });
  const view = fishingDepartureView(state);
  const rodOptions = Children.toArray(view.rod.props.children).filter(isValidElement);
  assert.deepEqual(rodOptions.map(option => option.props.value), ["reed_rod", "river_rod"]);
  const baitOptions = Children.toArray(view.bait.props.children).filter(isValidElement);
  assert.equal(baitOptions.find(option => option.props.value === "crumb_bait").props.disabled, true);
  assert.equal(baitOptions.find(option => option.props.value === "worm_bait").props.disabled, false);
  assert.notEqual(baitOptions.find(option => option.props.value === "none").props.disabled, true);
  view.rod.props.onChange({ target: { value: "willow_rod" } });
  view.bait.props.onChange({ target: { value: "crumb_bait" } });
  view.bait.props.onChange({ target: { value: "unknown_bait" } });
  assert.deepEqual(view.calls, [], "forged unowned selections cannot issue an equipment command");
  view.bait.props.onChange({ target: { value: "none" } });
  assert.deepEqual(view.calls, [["equip_fishing_bait", "none", 1, 0]]);
  assert.equal(state.fishing.equippedBaitId, "worm_bait", "selection is not applied optimistically");
});

test("departure exposes only owned hooks and waits for their confirmed selection before starting", () => {
  const state = snapshot({ fishing: fishingGear({ ownedHooks: ["bare_hook", "barbed_hook"], equippedHookId: "bare_hook", equippedBaitId: null }) });
  const view = fishingDepartureView(state);
  const options = Children.toArray(view.hook.props.children).filter(isValidElement);
  assert.deepEqual(options.map(option => option.props.value), ["bare_hook", "barbed_hook"]);
  assert.match(view.html, /Крючок/); assert.match(view.html, /Удочка и крючок не расходуются/);
  view.hook.props.onChange({ target: { value: "silver_hook" } });
  view.hook.props.onChange({ target: { value: "unknown_hook" } });
  assert.deepEqual(view.calls, [], "unowned and unknown hooks cannot issue an equipment command");
  view.hook.props.onChange({ target: { value: "barbed_hook" } }); view.start.props.onClick();
  assert.deepEqual(view.calls, [["equip_fishing_hook", "barbed_hook", 1, 0]]);
  assert.equal(state.fishing.equippedHookId, "bare_hook");
  assert.equal(state.inventory.barbed_hook, undefined);
  const confirmed = fishingDepartureView(snapshot({ fishing: { ...state.fishing, equippedHookId: "barbed_hook" } }));
  confirmed.start.props.onClick(); assert.deepEqual(confirmed.calls, [["start_fishing", "shore", 1, 0]]);
});

test("a missing owned hook blocks departure and saved jobs show their original hook after equipment changes", () => {
  const invalid = fishingDepartureView(snapshot({ fishing: fishingGear({ ownedHooks: ["bare_hook"], equippedHookId: "silver_hook", equippedBaitId: null }) }));
  assert.match(invalid.html, /Выберите крючок/); assert.match(invalid.html, /Выберите доступную удочку и крючок/);
  assert.equal(invalid.start.props.disabled, true); invalid.start.props.onClick(); assert.deepEqual(invalid.calls, []);
  const saved = job({ targetId: "shore", fishing: { rodId: "reed_rod", hookId: "barbed_hook", baitId: null, fishId: "fish" } });
  const state = snapshot({ jobs: [saved], fishing: fishingGear({ ownedHooks: ["bare_hook", "barbed_hook", "silver_hook"], equippedHookId: "silver_hook", equippedBaitId: null }) });
  const view = activeView(saved, { state });
  assert.match(view.html, /Крючок этой вылазки: Бородатый крючок/);
  assert.doesNotMatch(view.html, /Крючок этой вылазки: Серебряный крючок/);
  assert.notEqual(expeditionCancellationKey("ME", { ...saved, fishing: { ...saved.fishing, hookId: "silver_hook" } }), view.key);
  const legacy = activeView(job({ targetId: "shore", fishing: { rodId: "reed_rod", baitId: null, fishId: "fish" } }));
  assert.match(legacy.html, /Крючок этой вылазки: Простой крючок/);
});

test("equipping then immediately departing waits for a confirmed snapshot and never auto-starts", () => {
  const state = snapshot({ fishing: fishingGear({ equippedRodId: "reed_rod", equippedBaitId: null }) });
  const before = fishingDepartureView(state);
  before.rod.props.onChange({ target: { value: "river_rod" } });
  before.start.props.onClick(); before.start.props.onClick();
  assert.deepEqual(before.calls, [["equip_fishing_rod", "river_rod", 1, 0]], "equip and departure share the same synchronous receipt latch");
  const pending = fishingDepartureView(state, { busy: true });
  assert.equal(pending.rod.props.disabled, true); assert.equal(pending.hook.props.disabled, true); assert.equal(pending.bait.props.disabled, true); assert.equal(pending.start.props.disabled, true);
  pending.start.props.onClick(); assert.deepEqual(pending.calls, []);
  const confirmed = fishingDepartureView({ ...state, revision: state.revision + 1, fishing: { ...state.fishing, equippedRodId: "river_rod" } });
  assert.equal(confirmed.rod.props.value, "river_rod"); assert.equal(confirmed.start.props.disabled, false);
  assert.deepEqual(confirmed.calls, [], "confirmation only updates the loadout; it does not start a trip");
  confirmed.start.props.onClick(); confirmed.start.props.onClick();
  assert.deepEqual(confirmed.calls, [["start_fishing", "shore", 1, 0]]);
});

test("equipment selectors and departure honor receipt recovery, cooldown and stale owner/revision", () => {
  const state = snapshot({ fishing: fishingGear({ equippedRodId: "reed_rod", ownedHooks: ["bare_hook", "barbed_hook"], equippedHookId: "bare_hook", equippedBaitId: null }), inventory: { worm_bait: 2 } });
  for (const flags of [{ uncertain: true }, { busy: true }, { retryAt: now + 5000 },
    { snapshot: { ...state, ownerPublicId: "OTHER" } }, { snapshot: { ...state, revision: state.revision + 1 } }]) {
    const view = fishingDepartureView(state, flags);
    assert.equal(view.rod.props.disabled, true); assert.equal(view.hook.props.disabled, true); assert.equal(view.bait.props.disabled, true); assert.equal(view.start.props.disabled, true);
    view.rod.props.onChange({ target: { value: "river_rod" } }); view.hook.props.onChange({ target: { value: "barbed_hook" } }); view.bait.props.onChange({ target: { value: "worm_bait" } }); view.start.props.onClick();
    assert.deepEqual(view.calls, []);
  }
});

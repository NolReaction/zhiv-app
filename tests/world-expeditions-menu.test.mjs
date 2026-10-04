import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { WorldExpeditionsMenu, WorldExpeditionSector, ActiveExpedition, expeditionCancellationKey, expeditionSector, expeditionSectors } = await vite.ssrLoadModule("/features/economy/world-expeditions-menu.tsx");
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
function route(html, id) {
  const found = html.match(new RegExp(`<details\\b[^>]*data-route="${id}"[^>]*>[\\s\\S]*?<\\/details>`));
  assert.ok(found, `Missing route: ${id}`);
  return found[0];
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
  assert.equal([...html.matchAll(/<details\b/g)].length, 4);
  assert.ok(html.indexOf('data-route="forest"') < html.indexOf('data-route="old_woodland"'));
  assert.match(html, /Можно отправиться/);
  assert.match(html, /Нужно подготовиться/);
  assert.doesNotMatch(html, /role="dialog"|role="tablist"|Кошелёк|<h[123][^>]*>Обзор|Продать|Производство/);
  assert.equal(disabled(button(route(html, "forest"), "Отправиться")), false);
});

test("every catalog route belongs to exactly one sector and keeps its actual findings", () => {
  const expected = { forest: ["forest", "forest_camp", "old_woodland", "uplands"], shore: ["shore", "shore_camp", "coastal_deposits"], caves: ["cave", "deep_cave", "abandoned_quarry"] };
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
      assert.match(content, /<summary>/);
      assert.doesNotMatch(content, /<details[^>]*\bopen=/);
      for (const [itemId, count] of Object.entries(entry.rewards)) {
        assert.ok(content.includes(economyCatalog.items.find(item => item.id === itemId).name));
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
  assert.equal(disabled(button(shore, "Отправиться")), false);
});

test("selected route alone expands and resource labels remain available to assistive technology", () => {
  const html = renderSector("shore", controller(), { selectedRoute: "shore" });
  assert.match(route(html, "shore"), /<details[^>]*\bopen=/);
  assert.doesNotMatch(route(html, "shore_camp"), /<details[^>]*\bopen=/);
  assert.equal([...html.matchAll(/<details[^>]*\bopen=/g)].length, 1);
  assert.match(route(html, "shore"), /role="list" aria-label="Находки"/);
  assert.match(route(html, "shore_camp"), /data-compact="true"/);
});

test("locked routes explain all missing buildings and offer navigation only when supplied", () => {
  const html = route(render(controller(), { onNavigateStation() {} }), "old_woodland");
  assert.match(html, /Условия открытия/);
  assert.match(html, /нужен ур\. 3/);
  assert.match(html, /нужен ур\. 2/);
  assert.equal(disabled(button(html, "Отправиться")), true);
  assert.equal(disabled(button(html, "нужен ур. 3")), false);
  const withoutNavigation = route(render(), "old_woodland");
  assert.match(withoutNavigation, /<span>[^<]+ · нужен ур\. 3<\/span>/);
});

test("deep routes use actual consumable amounts, and missing provisions block departure", () => {
  const state = snapshot({ buildings: { home: 3, warehouse: 1 }, inventory: { dried_berries: 1 } });
  let html = route(renderSector("caves", controller({ snapshot: state })), "deep_cave");
  assert.match(html, /Припасы для вылазки/);
  assert.match(html, /Не хватает припасов/);
  assert.equal(disabled(button(html, "Отправиться")), true);
  html = route(renderSector("caves", controller({ snapshot: snapshot({ ...state, inventory: { dried_berries: 1, smoked_fish: 1 } }) })), "deep_cave");
  assert.equal(disabled(button(html, "Отправиться")), false);
});

test("departure compares reward size with total capacity; a full pantry can be cleared before return", () => {
  let state = snapshot({ storage: { capacity: 10, available: 10, used: 0, reserved: 0, overflow: 0 } });
  let html = route(render(controller({ snapshot: state })), "forest");
  assert.equal(disabled(button(html, "Отправиться")), true);
  assert.match(html, /Находки займут 12 мест, вместимость — 10/);
  assert.equal(disabled(button(html, "Расширить кладовую")), false);
  state = snapshot({ storage: { capacity: 200, available: 0, used: 170, reserved: 30, overflow: 0 } });
  html = route(render(controller({ snapshot: state })), "forest");
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
  const html = render(controller({ snapshot: snapshot({ jobs: [job({ kind: "construction", targetId: "home", rewards: {}, targetLevel: 2 }), job({ kind: "production", targetId: "garden", recipeId: "grow_berries", rewards: { berries: 6 } })] }) }));
  assert.doesNotMatch(html, /Текущая вылазка|Мохлик занят|Мохлик в пути/);
  assert.equal(disabled(button(route(html, "forest"), "Отправиться")), false);
});

test("busy, uncertain and cooldown states prevent both spending and reward claims", () => {
  for (const flags of [{ busy: true }, { uncertain: true }, { retryAt: now + 5_000 }]) {
    assert.equal(disabled(button(route(render(controller(flags)), "forest"), "Отправиться")), true);
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

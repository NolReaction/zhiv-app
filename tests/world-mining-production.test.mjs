import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const previousDocument = globalThis.document;
globalThis.document = { activeElement: null, body: {}, hidden: false };
after(() => { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; });
const hooksId = "virtual:mining-production-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "mining-production-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let slots = [], cursor = 0, effects = [];
      export function reset() { slots = []; cursor = 0; effects = []; }
      export function render() { cursor = 0; effects = []; }
      export function useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], v => slots[i] = typeof v === "function" ? v(slots[i]) : v]; }
      export function useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; }
      export function useId() { return "mining-production-test"; }
      export function useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((v, n) => !Object.is(v, old[n]))) { slots[i] = deps; effects.push(effect); } }
      export function flush() { const pending = effects; effects = []; pending.forEach(effect => effect()); }
    `; },
    transform(source, id) {
      if (["/ui/expeditions/world-mining-production.tsx", "/ui/expeditions/world-expeditions-menu.tsx", "/ui/fishing/use-fishing-command.ts"].some(path => id.endsWith(path))) {
        return source.replace('from "react";', `from "${hooksId}";`).replace("function MiningProduction(", "export function MiningProduction(");
      }
    },
  }],
});
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hooksId);
const { MiningProduction, MiningBatchCard } = await vite.ssrLoadModule("/features/economy/ui/expeditions/world-mining-production.tsx");
const { ActiveExpedition } = await vite.ssrLoadModule("/features/economy/ui/expeditions/world-expeditions-menu.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const now = Date.parse("2026-10-27T10:00:00Z");
const state = overrides => ({ ownerPublicId: "ME", revision: 7, wallet: { coins: 100, pearls: 0 }, inventory: {}, buildings: { home: 5, quarry: 5, warehouse: 5 },
  storage: { capacity: 250, available: 250, used: 0, reserved: 0 }, jobs: [], catalog: structuredClone(economyCatalog), ...overrides });
const job = overrides => ({ id: "mining-job", kind: "exploration", actorId: "miner", targetId: "quarry_stone", recipeId: null, targetLevel: null,
  startedAt: new Date(now - 60_000).toISOString(), finishesAt: new Date(now + 120_000).toISOString(), rewards: { stone: 1 }, cost: { coins: 0, items: {} }, catalogVersion: economyCatalog.version, ...overrides });
const controller = (snapshot, calls = []) => ({ snapshot, now, error: null, busy: false, uncertain: false, retryAt: 0, directActionsAvailable: true, act: (...args) => { calls.push(args); return true; }, retry() {}, refresh() {} });
function nodes(tree) { const out = []; function walk(value) { if (!isValidElement(value)) return; out.push(value); Children.forEach(value.props.children, walk); } walk(tree); return out; }
function overview(economy, props = {}) { hooks.render(); const tree = MiningProduction({ economy, state: economy.snapshot, onOpenPantry() {}, ...props }); return { tree, nodes: nodes(tree), html: renderToStaticMarkup(tree) }; }
function active(economy, saved, props = {}) { hooks.render(); const tree = ActiveExpedition({ economy, state: economy.snapshot, job: saved, compact: true, onOpenPantry() {}, confirmationKey: null, onConfirmation() {}, onCancellationSent() {}, ...props }); return { tree, nodes: nodes(tree), html: renderToStaticMarkup(tree) }; }

test("quantity presets launch one sequential batch and show the total time", () => {
  hooks.reset(); const calls = [], economy = controller(state(), calls);
  let view = overview(economy); hooks.flush();
  view.nodes.find(node => node.type === "button" && node.props.children === 10).props.onClick();
  view = overview(economy); hooks.flush();
  const button = view.nodes.find(node => node.props["data-route"] === "quarry_stone");
  assert.match(button.props["aria-label"], /30/);
  button.props.onClick(); button.props.onClick();
  assert.deepEqual(calls, [["start_exploration", "quarry_stone", 10, 0]]);
});

test("quantity controls respect the quarry level and slow resources show their smaller exact order", () => {
  hooks.reset(); const low = controller(state({ buildings: { home: 2, quarry: 1 } }));
  let view = overview(low);
  assert.equal(view.nodes.find(node => node.props["aria-label"] === "Количество единиц добычи").props.max, 5);
  assert.equal(view.nodes.some(node => node.type === "button" && node.props.children === 10), false);
  hooks.reset(); const calls = [], high = controller(state(), calls);
  view = overview(high); hooks.flush();
  view.nodes.find(node => node.props["aria-label"] === "Максимальная партия: до 15").props.onClick();
  view = overview(high); hooks.flush();
  const limestone = view.nodes.find(node => node.props["data-route"] === "quarry_limestone");
  assert.match(limestone.props["aria-label"], /×3/);
  limestone.props.onClick();
  assert.deepEqual(calls, [["start_exploration", "quarry_limestone", 3, 0]]);
});

test("batch card collects completed units while displaying the still-running queue", () => {
  hooks.reset(); const calls = [], saved = job({ startedAt: new Date(now - 600_000).toISOString(), finishesAt: new Date(now + 1200_000).toISOString(),
    miningBatch: { quantity: 10, claimed: 0, unitSeconds: 180, unitRewards: { stone: 1 } } });
  const economy = controller(state({ jobs: [saved] }), calls);
  hooks.render(); const tree = MiningBatchCard({ economy, state: economy.snapshot, job: saved, onOpenPantry() {} });
  const html = renderToStaticMarkup(tree), controls = nodes(tree);
  assert.match(html, /Добыто 3 из 10/); assert.match(html, /Забрать доступное/);
  assert.match(html, /До конца заказа/); assert.match(html, /Осталось 7/); assert.match(html, /aria-valuenow="33"/);
  const collect = controls.find(node => node.props["data-production-control"]);
  assert.equal(collect.props.disabled, false); collect.props.onClick(); collect.props.onClick();
  assert.deepEqual(calls, [["claim_job", saved.id, 1, 0]]);
  assert.match(html, /Остановить остаток/); assert.doesNotMatch(html, /Отказаться от находок|потеряны/);
});

test("partial collection explains capacity without promising that all ready units fit", () => {
  hooks.reset(); const saved = job({ startedAt: new Date(now - 600_000).toISOString(), finishesAt: new Date(now + 840_000).toISOString(),
    miningBatch: { quantity: 8, claimed: 0, unitSeconds: 180, unitRewards: { stone: 1 } } });
  const economy = controller(state({ jobs: [saved], storage: { capacity: 50, available: 1, used: 49, reserved: 0 } }));
  hooks.render(); const tree = MiningBatchCard({ economy, state: economy.snapshot, job: saved, onOpenPantry() {} });
  assert.match(renderToStaticMarkup(tree), /поместится до 1 из 3/);
  assert.equal(nodes(tree).find(node => node.props["data-production-control"]).props.disabled, false);
  hooks.reset(); economy.snapshot.storage.available = 0;
  hooks.render(); const full = MiningBatchCard({ economy, state: economy.snapshot, job: saved, onOpenPantry() {} });
  assert.equal(nodes(full).find(node => node.props["data-production-control"]).props.disabled, true);
  assert.match(renderToStaticMarkup(full), /Освободить кладовую/);
  hooks.reset(); saved.rewards = { stone: 1, relic: 1 }; economy.snapshot.storage.available = 4;
  hooks.render(); const firstRare = MiningBatchCard({ economy, state: economy.snapshot, job: saved, onOpenPantry() {} });
  assert.doesNotMatch(renderToStaticMarkup(firstRare), /поместится до 2/);
  assert.equal(nodes(firstRare).find(node => node.props["data-production-control"]).props.disabled, false);
});

test("the mine renders exactly one permanent place and one compact card for each actual resource", () => {
  hooks.reset(); const calls = [], economy = controller(state(), calls), view = overview(economy);
  assert.equal(view.nodes.filter(n => n.props["data-production-slot"]).length, 1);
  assert.match(view.html, /Свободно 1 из 1/); assert.match(view.html, /Что добывать\?/);
  assert.doesNotMatch(view.html, /Место 2|Место 3|Открыть место|data-miningSingle|Подготовиться|data-route-preparation/);
  const routes = economy.snapshot.catalog.explorations.filter(route => route.activity === "mining" && !route.retired);
  assert.deepEqual(view.nodes.filter(n => n.props["data-route"]).map(n => n.props["data-route"]).sort(), routes.map(r => r.id).sort());
  assert.deepEqual(calls, []);
});

test("resource clicks launch the actual exploration once and stale owner/revision controls cannot submit", () => {
  hooks.reset(); const calls = [], economy = controller(state(), calls), view = overview(economy); hooks.flush();
  const button = view.nodes.find(n => n.props["data-route"] === "quarry_stone");
  button.props.onClick(); button.props.onClick();
  assert.deepEqual(calls, [["start_exploration", "quarry_stone", 1, 0]]);
  hooks.reset(); const original = state(), next = controller(original, calls), old = overview(next); hooks.flush();
  next.snapshot = state({ ownerPublicId: "OTHER", revision: 8 });
  old.nodes.find(n => n.props["data-route"] === "quarry_stone").props.onClick();
  assert.equal(calls.length, 1);
});

test("working and ready mining keep the one slot occupied and prevent another launch", () => {
  for (const ready of [false, true]) {
    hooks.reset(); const saved = job({ finishesAt: new Date(now + (ready ? 0 : 30_000)).toISOString() });
    const calls = [], economy = controller(state({ jobs: [saved] }), calls), view = overview(economy); hooks.flush();
    assert.match(view.html, /Свободно 0 из 1/);
    assert.equal(view.nodes.filter(n => n.props["data-production-slot"]).length, 1);
    assert.equal(view.nodes.filter(n => n.props["data-route"]).length, 0);
    assert.doesNotMatch(view.html, /Количество единиц добычи|Что добывать/);
    assert.deepEqual(calls, []);
  }
});

test("the displayed countdown uses the existing saved job and cancellation requires explicit current-job approval", () => {
  hooks.reset(); const saved = job(), calls = [], economy = controller(state({ jobs: [saved] }), calls);
  let key = null;
  let view = active(economy, saved, { onConfirmation: value => { key = value; } }); hooks.flush();
  const control = view.nodes.find(n => n.props["data-production-control"]);
  assert.match(view.html, /2:00/); control.props.onClick(); assert.ok(key); assert.deepEqual(calls, []);
  view = active(economy, saved, { confirmationKey: key, onConfirmation: value => { key = value; } }); hooks.flush();
  view.nodes.find(n => n.type === "button" && renderToStaticMarkup(n).includes("Остановить без результата")).props.onClick();
  assert.deepEqual(calls, [["cancel_exploration", saved.id]]);
  assert.equal(key, null);
});

test("claim preserves storage blockers, pantry access, stale-job protection and the duplicate-click latch", () => {
  hooks.reset(); const saved = job({ finishesAt: new Date(now).toISOString() }), calls = [], economy = controller(state({ jobs: [saved], storage: { capacity: 250, available: 0, used: 250, reserved: 0 } }), calls);
  let pantry = 0; let view = active(economy, saved, { onOpenPantry: () => pantry++ }); hooks.flush();
  assert.equal(view.nodes.find(n => n.props["data-production-control"]).props.disabled, true);
  view.nodes.find(n => n.props["data-production-control"]).props.onClick(); assert.deepEqual(calls, []);
  view.nodes.find(n => n.type === "button" && renderToStaticMarkup(n).includes("К кладовой")).props.onClick(); assert.equal(pantry, 1);
  economy.snapshot = state({ revision: 8, jobs: [saved] }); view = active(economy, saved); hooks.flush();
  const claim = view.nodes.find(n => n.props["data-production-control"]); claim.props.onClick(); claim.props.onClick();
  assert.deepEqual(calls, [["claim_job", saved.id]]);
  economy.snapshot = state({ ownerPublicId: "OTHER", jobs: [saved] }); claim.props.onClick(); assert.equal(calls.length, 1);
});

test("confirmed mining or a new revision removes obsolete launch feedback", () => {
  hooks.reset(); const economy = controller(state()), first = overview(economy); hooks.flush();
  first.nodes.find(n => n.props["data-route"] === "quarry_stone").props.onClick();
  assert.match(overview(economy).html, /Запускаем добычу/);
  economy.snapshot = state({ jobs: [job()] });
  assert.doesNotMatch(overview(economy).html, /Запускаем добычу/);
  economy.snapshot = state({ revision: 8 });
  assert.doesNotMatch(overview(economy).html, /Запускаем добычу/);
});

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
const { MiningProduction } = await vite.ssrLoadModule("/features/economy/ui/expeditions/world-mining-production.tsx");
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

test("the mine renders exactly one permanent place and one compact card for each actual resource", () => {
  hooks.reset(); const calls = [], economy = controller(state(), calls), view = overview(economy);
  assert.equal(view.nodes.filter(n => n.props["data-production-slot"]).length, 1);
  assert.match(view.html, /Свободно 1 из 1/); assert.match(view.html, /Что произвести\?/);
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
    view.nodes.find(n => n.props["data-route"] === "quarry_clay").props.onClick();
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

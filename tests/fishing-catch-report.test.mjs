import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:catch-report-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-catch-report-vite-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "catch-report-hooks", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots = [], cursor = 0, effects = [];
      export function reset() { slots = []; cursor = 0; effects = []; }
      export function render() { cursor = 0; effects = []; }
      export function flush() { for (const effect of effects) effect(); }
      export function useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; }
      export function useId() { return useRef('catch-' + cursor).current; }
      export function useState(initial) { const slot = useRef(typeof initial === 'function' ? initial() : initial); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value; }]; }
      export function useEffect(effect, dependencies) { const previous = useRef(null); if (!previous.current || dependencies.some((value, index) => !Object.is(value, previous.current[index]))) { previous.current = dependencies; effects.push(effect); } }
    `; },
    transform(source, id) { if (id.endsWith("/features/economy/ui/expeditions/world-expeditions-menu.tsx")) return source.replace('from "react";', `from "${hookModule}";`); },
  }],
});
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hookModule);
const { FishingCatchReport, fishingCatchRevealed } = await vite.ssrLoadModule("/features/economy/ui/fishing/fishing-catch-report.tsx");
const { ActiveExpedition } = await vite.ssrLoadModule("/features/economy/ui/expeditions/world-expeditions-menu.tsx");
const { InventoryGainContents } = await vite.ssrLoadModule("/features/world/ui/feedback/world-inventory-gains.tsx");
const { economyCatalog: catalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const now = Date.parse("2026-10-14T21:00:00Z");
const savedJob = (overrides = {}) => ({ id: "fish-report", kind: "exploration", targetId: "shore", recipeId: null, targetLevel: null,
  startedAt: new Date(now - 180_000).toISOString(), finishesAt: new Date(now).toISOString(), rewards: { fish: 8, ancient_core: 1 }, cost: { coins: 0, items: {} }, catalogVersion: 10,
  fishing: { rodId: "willow_rod", hookId: "bare_hook", baitId: null, fishId: "fish" }, ...overrides });
const snapshot = (job, overrides = {}) => ({ ownerPublicId: "catch-owner", revision: 1, serverTime: new Date(now - 1000).toISOString(), catalog,
  wallet: { coins: 100, pearls: 0 }, inventory: {}, buildings: { home: 3, warehouse: 1 }, jobs: [job], fishing: { catches: {} },
  storage: { capacity: 100, used: 0, reserved: 0, available: 100, overflow: 0 }, ...overrides });
function props(job = savedJob(), overrides = {}) {
  const state = snapshot(job), reads = [], actions = [];
  return { state, job, reads, actions, onOpenPantry() {}, onConfirmation() {}, onCancellationSent() {}, confirmationKey: null,
    economy: { snapshot: state, busy: false, uncertain: false, retryAt: 0, now: now - 1000, refresh() { reads.push("refresh"); }, act(...args) { actions.push(args); } }, ...overrides };
}
function renderActive(value) { hooks.render(); const tree = ActiveExpedition(value); hooks.flush(); return renderToStaticMarkup(tree); }
function clientEnvironment(body) {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document"), navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const document = { hidden: false, activeElement: null }, navigator = { onLine: true };
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigator });
  try { body(document, navigator); } finally {
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor); else delete globalThis.document;
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor); else delete globalThis.navigator;
  }
}

test("actual completed catches show saved species drawings, quantities and rarity before personal discovery", () => {
  const job = savedJob({ rewards: { fish_silverfin: 3, fish_rudd: 2, fish_mooncarp: 2, fish_shark: 1 }, fishing: { ...savedJob().fishing, catchRevealed: true } });
  const state = snapshot(job, { serverTime: new Date(now).toISOString() });
  assert.equal(fishingCatchRevealed(state, job), true);
  const html = renderToStaticMarkup(createElement(FishingCatchReport, { state, rewards: job.rewards, revealed: true }));
  for (const [id, count] of Object.entries(job.rewards)) {
    assert.match(html, new RegExp(`data-fish-catch="${id}" data-quantity="${count}"`));
    assert.match(html, new RegExp(`data-item-icon="${id}"`));
  }
  assert.match(html, /data-fish-rarity="legendary"/); assert.match(html, /data-fish-rarity="rare"/);
  assert.doesNotMatch(html, /data-hidden-fish|Речная рыба/); assert.deepEqual(state.fishing.catches, {});
});

test("unfinished or old masked catches show only a neutral total, never eight invented river fish", () => {
  const job = savedJob(), state = snapshot(job);
  assert.equal(fishingCatchRevealed(state, job), false);
  assert.equal(fishingCatchRevealed({ ...state, serverTime: new Date(now).toISOString() }, job), false, "an ambiguous older all-river placeholder needs a server marker");
  const html = renderToStaticMarkup(createElement(FishingCatchReport, { state, rewards: job.rewards, revealed: false }));
  assert.match(html, /data-pending-catch="8"/); assert.match(html, /Улов · <strong>8<\/strong> рыб/);
  assert.doesNotMatch(html, /Речная рыба|data-item-icon="fish"|data-fish-rarity|data-fish-catch=/);
  assert.equal(fishingCatchRevealed({ ...state, serverTime: "invalid" }, { ...job, fishing: { ...job.fishing, catchRevealed: true } }), false);
});

test("legacy explicit class rewards show their actual classes without fabricating collection species", () => {
  const job = savedJob({ rewards: { fish_common: 5, fish_rare: 2, fish_epic: 1 } }), state = snapshot(job, { serverTime: new Date(now).toISOString() });
  assert.equal(fishingCatchRevealed(state, job), true);
  const html = renderToStaticMarkup(createElement(FishingCatchReport, { state, rewards: job.rewards, revealed: true }));
  assert.match(html, /data-fish-catch="fish_rare" data-quantity="2"/); assert.match(html, /data-item-icon="fish_epic"/);
  assert.doesNotMatch(html, /data-item-icon="fish_mooncarp"/);
});

test("reaching a masked deadline performs one read, then a confirmed snapshot reveals actual catch and keeps extras", () => clientEnvironment(() => {
  hooks.reset(); const value = props();
  assert.match(renderActive(value), /data-pending-catch="8"/); assert.deepEqual(value.reads, []);
  value.economy.now = now;
  const pending = renderActive(value); assert.match(pending, /data-pending-catch="8"/); assert.deepEqual(value.reads, ["refresh"]);
  for (let tick = 1; tick <= 30; tick++) { value.economy.now = now + tick * 1000; renderActive(value); }
  assert.deepEqual(value.reads, ["refresh"], "a still-masked server response cannot create a polling loop");
  const ready = savedJob({ rewards: { fish_silverfin: 3, fish_rudd: 4, fish_mooncarp: 1, ancient_core: 1 }, fishing: { ...savedJob().fishing, catchRevealed: true } });
  value.job = ready; value.state = snapshot(ready, { serverTime: new Date(now).toISOString() }); value.economy.snapshot = value.state;
  const revealed = renderActive(value);
  assert.match(revealed, /data-fish-catch="fish_silverfin" data-quantity="3"/); assert.match(revealed, /data-item-icon="ancient_core"/);
  assert.doesNotMatch(revealed, /data-pending-catch|Крючок этой вылазки/);
  assert.deepEqual(value.reads, ["refresh"]); assert.deepEqual(value.actions, [], "reveal is a read, never an automatic claim");
}));

test("deadline reads wait for connectivity and clear locks, and do not refresh foreign or already revealed jobs", () => clientEnvironment((document, navigator) => {
  const flags = ["offline", "hidden", "explicit-offline", "busy", "uncertain", "cooldown", "foreign", "revealed"];
  for (const flag of flags) {
    hooks.reset(); document.hidden = flag === "hidden"; navigator.onLine = flag !== "offline";
    const value = props(); value.economy.now = now;
    if (flag === "explicit-offline") value.isOnline = false;
    if (flag === "busy") value.economy.busy = true;
    if (flag === "uncertain") value.economy.uncertain = true;
    if (flag === "cooldown") value.economy.retryAt = now + 10_000;
    if (flag === "foreign") value.economy.snapshot = { ...value.state, ownerPublicId: "other" };
    if (flag === "revealed") { value.job = savedJob({ fishing: { ...savedJob().fishing, catchRevealed: true } }); value.state = snapshot(value.job, { serverTime: new Date(now).toISOString() }); value.economy.snapshot = value.state; }
    renderActive(value); assert.deepEqual(value.reads, [], flag); assert.deepEqual(value.actions, [], flag);
    if (!["foreign", "revealed"].includes(flag)) {
      document.hidden = false; navigator.onLine = true; value.isOnline = true; value.economy.busy = false; value.economy.uncertain = false; value.economy.retryAt = 0; value.economy.now++;
      renderActive(value); assert.deepEqual(value.reads, ["refresh"], `${flag} did not consume its one attempt`);
    }
  }
}));

test("new job identity or authoritative deadline gets its own read without letting old render ticks repeat it", () => clientEnvironment(() => {
  hooks.reset(); const value = props(); value.economy.now = now; renderActive(value);
  const next = savedJob({ id: "next-fish-report" }); value.job = next; value.state = snapshot(next); value.economy.snapshot = value.state;
  renderActive(value); renderActive(value); assert.deepEqual(value.reads, ["refresh", "refresh"]);
  const changed = { ...next, finishesAt: new Date(now + 10_000).toISOString() };
  value.job = changed; value.state = snapshot(changed); value.economy.snapshot = value.state; value.economy.now = now + 9999;
  renderActive(value); assert.equal(value.reads.length, 2);
  value.economy.now++; renderActive(value); renderActive(value); assert.equal(value.reads.length, 3);
}));

test("confirmed gain presentation uses proven species, leaves economic classes intact and keeps accessible overflow", () => {
  const job = savedJob(), state = snapshot(job), items = [{ itemId: "fish_common", quantity: 5 }, { itemId: "fish_rare", quantity: 2 }, { itemId: "fish_legendary", quantity: 1 }, { itemId: "ancient_core", quantity: 1 }];
  const displayItems = [{ itemId: "fish_silverfin", quantity: 3 }, { itemId: "fish_rudd", quantity: 2 }, { itemId: "fish_mooncarp", quantity: 2 }, { itemId: "fish_shark", quantity: 1 }, { itemId: "ancient_core", quantity: 1 }];
  const event = { id: "accepted", ownerPublicId: state.ownerPublicId, revision: 2, source: "claim", items, displayItems };
  const names = Object.fromEntries(catalog.items.map(item => [item.id, item.name]));
  const html = renderToStaticMarkup(createElement(InventoryGainContents, { event, names, state }));
  assert.match(html, /data-inventory-item="fish_silverfin" data-quantity="3"/); assert.match(html, /data-item-icon="fish_mooncarp"/);
  assert.match(html, /data-fish-rarity="rare"/); assert.match(html, /Ещё предметов: 2/);
  assert.match(html, /Теневая акула \+1/); assert.doesNotMatch(html, /data-hidden-fish|data-item-icon="fish_common"/);
  assert.equal(event.items, items); assert.deepEqual(state.fishing.catches, {});
});

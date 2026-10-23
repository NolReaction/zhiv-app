import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-production-collection-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { inventoryGainFromReceipt } = await vite.ssrLoadModule("/features/economy/domain/inventory-gain.ts");
const { WorldProductionSlots } = await vite.ssrLoadModule("/features/economy/ui/production/world-production-slots.tsx");
const now = Date.parse("2026-10-23T12:00:00Z"), iso = value => new Date(value).toISOString();
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
function player(station = "woodlot", rewards = { wood: 1 }) {
  const p = identities.createDevIdentity("Собиратель", crypto.randomUUID());
  economy.getDevEconomy(p.token, now);
  p.row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  const recipeId = station === "woodlot" ? "gather_wood" : station === "kiln" ? "make_bricks" : station === "dryer" ? "cook_berry_compote" : "make_planks";
  const job = { id: crypto.randomUUID(), kind: "production", targetId: station, recipeId, rewards, cost: { coins: 0, items: {} }, catalogVersion: 12, startedAt: iso(now - 5000), finishesAt: iso(now) };
  Object.assign(p.row.state, { inventory: {}, buildings: { ...p.row.state.buildings, home: 5, woodlot: 1, workshop: 1, kiln: 1, dryer: 1 },
    productionSlots: { [station]: 3 }, jobs: [job, { ...structuredClone(job), id: crypto.randomUUID() },
      { ...structuredClone(job), id: crypto.randomUUID(), finishesAt: iso(now + 1000) }] });
  return p;
}
const read = p => economy.getDevEconomy(p.token, now);
const command = (p, station = "woodlot", patch = {}) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: read(p).revision, action: "claim_production", targetId: station, quantity: 1, totalPrice: 0, ...patch });

test("one atomic station claim collects every ready cell, preserves unfinished work and celebrates the confirmed total once", () => {
  for (const [station, rewards] of [["woodlot", { wood: 1 }], ["workshop", { planks: 1 }], ["kiln", { bricks: 1 }], ["dryer", { berry_compote: 1 }]]) {
    const p = player(station, rewards), before = read(p), request = command(p, station);
    const result = economy.commandDevEconomy(p.token, request, now);
    assert.deepEqual(result.state.inventory, Object.fromEntries(Object.entries(rewards).map(([id, value]) => [id, value * 2])));
    assert.deepEqual(result.state.jobs.map(job => job.id), [before.jobs[2].id]);
    assert.equal(result.state.progression.recipes[before.jobs[0].recipeId], (before.progression.recipes[before.jobs[0].recipeId] ?? 0) + 2);
    assert.deepEqual(inventoryGainFromReceipt(before, result, request)?.items, Object.entries(rewards).map(([itemId, quantity]) => ({ itemId, quantity: quantity * 2 })));
    assert.equal(inventoryGainFromReceipt(before, result, request)?.stationId, station);
    assert.equal(inventoryGainFromReceipt(result.state, result, request), null);
    const replay = economy.commandDevEconomy(p.token, request, now + 2000);
    assert.equal(replay.replayed, true); assert.deepEqual(replay.state.inventory, result.state.inventory);
    assert.equal(replay.state.jobs.length, 1, "later completed work is not included in an earlier receipt replay");
    assert.throws(() => economy.commandDevEconomy(p.token, { ...request, requestId: crypto.randomUUID() }, now), { code: "ECONOMY_REVISION_CONFLICT" });
  }
});

test("full storage rejects the entire batch without consuming cells, progression or revision", () => {
  const p = player(), request = command(p);
  p.row.state.inventory = { stone: 49 };
  const before = read(p);
  assert.throws(() => economy.commandDevEconomy(p.token, request, now), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(read(p), before);
  p.row.state.inventory = { stone: 48 };
  assert.equal(economy.commandDevEconomy(p.token, request, now).state.inventory.wood, 2);
});

test("station collection cannot bypass berry delivery, finish construction, claim another station or forge quantity or price", () => {
  const p = player(), before = read(p), gardenJob = { ...structuredClone(before.jobs[0]), id: crypto.randomUUID(), targetId: "garden", recipeId: "grow_berries", rewards: { berries: 1 } };
  p.row.state.jobs.push(gardenJob, { ...structuredClone(before.jobs[0]), id: crypto.randomUUID(), kind: "construction", targetId: "woodlot", targetLevel: 2, rewards: {} });
  for (const station of ["garden", "workshop", "kiln"]) assert.throws(() => economy.commandDevEconomy(p.token, command(p, station), now), { code: "ECONOMY_JOB_NOT_READY" });
  for (const station of ["home", "quarry", "unknown"]) assert.throws(() => economy.commandDevEconomy(p.token, command(p, station), now), { code: "ECONOMY_PRODUCTION_STATION" });
  for (const patch of [{ quantity: 2 }, { totalPrice: 1 }, { fishSelection: { fish: 1 } }]) assert.throws(() => economy.commandDevEconomy(p.token, command(p, "woodlot", patch), now), { code: "INVALID_ECONOMY_COMMAND" });
  const result = economy.commandDevEconomy(p.token, command(p), now).state;
  assert.equal(result.buildings.woodlot, 1); assert.ok(result.jobs.some(job => job.kind === "construction"));
  assert.ok(result.jobs.some(job => job.id === gardenJob.id));
  const stranger = player(); assert.throws(() => economy.commandDevEconomy(stranger.token, command(p), now), { code: "ECONOMY_OWNER_CHANGED" });
});

function elements(tree) { const result = []; function walk(node) { if (!isValidElement(node)) return; result.push(node); Children.forEach(node.props.children, walk); } walk(tree); return result; }
function slots(controller) { let tree; function Probe() { return tree = WorldProductionSlots({ economy: controller, stationId: "woodlot" }); } const html = renderToStaticMarkup(createElement(Probe)); return { html, button: elements(tree).find(node => node.props["data-collect-production"]) }; }
test("bulk control is available for multiple confirmed ready cells and gates full storage and duplicate clicks", () => {
  const p = player(), calls = [], controller = { snapshot: read(p), now, retryAt: 0, busy: false, uncertain: false, error: null,
    act(...args) { calls.push(args); return true; } };
  const view = slots(controller); assert.match(view.html, /Собрать всё \(2\)/);
  view.button.props.onClick(); view.button.props.onClick(); assert.deepEqual(calls, [["claim_production", "woodlot"]]);
  const blocked = slots({ ...controller, snapshot: { ...controller.snapshot, storage: { ...controller.snapshot.storage, available: 1 } } });
  assert.equal(blocked.button.props.disabled, true); assert.match(blocked.html, /Освободите 1 мест/);
  blocked.button.props.onClick(); assert.equal(calls.length, 1);
  const pending = slots({ ...controller, pendingProductionCount: 1 }); assert.equal(pending.button.props.disabled, true);
  pending.button.props.onClick(); assert.equal(calls.length, 1);
});

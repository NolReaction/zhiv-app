import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-network-error-routing-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createWorldSession } = await vite.ssrLoadModule("/features/world/state/session.ts");
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const { WorldFeedback } = await vite.ssrLoadModule("/features/world/ui/feedback/world-feedback.tsx");
const { newWorldState } = await vite.ssrLoadModule("/features/world/domain/model.ts");
const { economyCatalog, economyViewSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const owner = "AAAA-0000-0001", time = "2026-10-15T12:00:00.000Z";
const worldState = () => ({ ownerPublicId: owner, revision: 1, serverTime: time, state: newWorldState(), gifts: [], dailySparksEarned: 0, catalogVersion: 1 });
const economyState = () => economyViewSchema.parse({ ownerPublicId: owner, revision: 1, serverTime: time, wallet: { coins: 1000, pearls: 0 }, inventory: {},
  buildings: { home: 1, garden: 1, warehouse: 1 }, storage: { capacity: 50, used: 0, reserved: 0, available: 50, overflow: 0 }, jobs: [],
  migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, completedExplorations: 0, catalog: economyCatalog });
const flush = () => new Promise(resolve => setImmediate(resolve));

test("retained world transport errors stay out of the large toast while business failures remain visible", async () => {
  for (const failure of [new Error("Network"), new ApiError("Подождите сеть", 429), new ApiError("Нужен материал", 409)]) {
    const session = createWorldSession(owner, { get: async () => worldState(), send: async () => { throw failure; } }, () => assert.fail());
    const stop = session.activate();
    try {
      await session.refresh(); session.act("upgrade_house"); await flush();
      const view = session.getSnapshot(), transport = failure.status !== 409;
      assert.equal(Boolean(view.syncError), transport);
      assert.equal(Boolean(view.error), true, "controller error remains available to reconciliation");
      const html = renderToStaticMarkup(createElement(WorldFeedback, { world: { ...view, retry: session.retry } }));
      if (transport) assert.equal(html, ""); else assert.match(html, /Нужен материал/);
    } finally { stop(); }
  }
});

test("failed background reads preserve the retained snapshots and cannot satisfy world or economy reconciliation", async () => {
  for (const kind of ["world", "economy"]) {
    let broken = false;
    const transport = { get: async () => { if (broken) throw new Error("Offline"); return kind === "world" ? worldState() : economyState(); }, send: async () => assert.fail(), market: async () => assert.fail(), trade: async () => assert.fail() };
    const session = kind === "world" ? createWorldSession(owner, transport, () => assert.fail()) : createEconomySession(owner, transport, () => assert.fail());
    const stop = session.activate();
    try {
      await session.refresh(); const confirmed = session.getSnapshot().snapshot;
      broken = true; await session.refresh();
      assert.equal(session.getSnapshot().snapshot, confirmed);
      assert.ok(session.getSnapshot().syncError);
      assert.ok(session.getSnapshot().error);
      session.setAvailable(false);
      assert.equal(await session.reconcile(), false, "a stale retained snapshot does not masquerade as a successful read");
      broken = false; session.setAvailable(false);
      assert.equal(await session.reconcile(), true);
      assert.equal(session.getSnapshot().syncError, null);
      assert.equal(session.getSnapshot().error, null);
    } finally { stop(); }
  }
});

test("market and barter network markers clear independently without hiding definitive shelf errors", async () => {
  const previous = globalThis.performance;
  let monotonic = 1000, marketFailure = new Error("Market offline"), barterFailure = new Error("Barter offline");
  globalThis.performance = { now: () => monotonic };
  const session = createEconomySession(owner, { get: async () => economyState(), send: async () => assert.fail(), trade: async () => assert.fail(),
    market: async () => { if (marketFailure) throw marketFailure; return { listings: [], mine: [], nextCursor: null, serverTime: time }; },
    barter: async () => { if (barterFailure) throw barterFailure; return { ownerPublicId: owner }; },
  }, () => assert.fail());
  const stop = session.activate();
  try {
    await session.refresh(); await session.refreshMarket(); await session.refreshBarter();
    assert.ok(session.getSnapshot().marketSyncError); assert.ok(session.getSnapshot().barterSyncError);
    assert.ok(session.getSnapshot().marketError); assert.ok(session.getSnapshot().barterError);
    await session.refresh();
    assert.ok(session.getSnapshot().marketSyncError, "an economy GET cannot clear a different read channel");
    monotonic += 4000; marketFailure = null; await session.refreshMarket();
    assert.equal(session.getSnapshot().marketSyncError, null); assert.equal(session.getSnapshot().marketError, null);
    assert.ok(session.getSnapshot().barterSyncError);
    barterFailure = new ApiError("Обмен пока закрыт", 409); await session.refreshBarter();
    assert.equal(session.getSnapshot().barterSyncError, null); assert.equal(session.getSnapshot().barterError, "Обмен пока закрыт");
    monotonic += 4000; barterFailure = null; await session.refreshBarter();
    assert.equal(session.getSnapshot().barterSyncError, null); assert.equal(session.getSnapshot().barterError, null);
  } finally { stop(); globalThis.performance = previous; }
});

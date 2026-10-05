import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const api = await vite.ssrLoadModule("/features/admin/admin-api.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => vite.close());
const publicId = "7K3P-2Q9M-W8ZR", serverTime = "2026-10-05T12:00:00Z";
const emptyPlayer = { publicId, displayName: "Новый игрок", initialized: false, updatedAt: null, revision: null,
  coins: null, pearls: null, homeLevel: null, completedExplorations: null, storage: null,
  runningJobs: 0, readyJobs: 0, awaitingCollectionJobs: 0, blockedReadyJobs: 0 };
const summary = { players: 1, initializedPlayers: 0, uninitializedPlayers: 1, coins: 0, pearls: 0,
  runningJobs: 0, readyJobs: 0, storageBlockedPlayers: 0, overflowPlayers: 0, updatedLast24Hours: 0 };
const page = { serverTime, total: 1, offset: 0, limit: 25, summary, players: [emptyPlayer] };
const economy = { ownerPublicId: publicId, revision: 4, serverTime, wallet: { coins: 321, pearls: 7 },
  inventory: { wood: 20 }, buildings: { home: 1, warehouse: 1 }, jobs: [],
  migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 },
  catalog: economyCatalog, storage: { capacity: 200, used: 20, reserved: 5, available: 175, overflow: 0 },
  completedExplorations: 1, fishing: { ownedRods: ["reed_rod"], equippedRodId: "reed_rod", equippedBaitId: null, catches: {} } };
const detail = { publicId, displayName: "Игрок", serverTime, updatedAt: serverTime, economy, jobStatuses: [],
  ledger: [{ kind: "sell", coins: 10, pearls: -1, items: { wood: -5 }, createdAt: serverTime }] };

test("economy list preserves missing profiles and sends literal bounded query without credentials in headers", async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/v1/admin/economy?q=100%25_%D0%B8%D0%B3%D1%80%D0%BE%D0%BA&sort=ready&offset=0&limit=25");
    assert.equal(options.method, "GET"); assert.equal(options.cache, "no-store"); assert.equal(options.credentials, "same-origin");
    assert.equal(options.headers.Authorization, undefined);
    return Response.json(page);
  };
  const response = await api.getAdminEconomy({ q: "100%_игрок", sort: "ready", offset: 0, limit: 25 });
  assert.equal(response.players[0].coins, null); assert.equal(response.players[0].initialized, false);
});

test("economy detail accepts signed journal deltas but strips private seeds", async () => {
  globalThis.fetch = async url => {
    assert.equal(url, `/api/v1/admin/users/${publicId}/economy`);
    return Response.json({ ...detail, economy: { ...economy, fishingCastSeed: "private" } });
  };
  const response = await api.getAdminEconomyPlayer(publicId);
  assert.equal(response.ledger[0].items.wood, -5); assert.equal(response.ledger[0].pearls, -1);
  assert.equal(response.economy.storage.reserved, 5); assert.equal("fishingCastSeed" in response.economy, false);
});

test("mismatched players, pages and job observations cannot become trusted admin data", async () => {
  const options = { q: "", sort: "updated", offset: 0, limit: 25 };
  for (const body of [{ ...page, offset: 25 }, { ...page, summary: { ...summary, players: 2 } },
    { ...page, players: [{ ...emptyPlayer, coins: 0 }] }]) {
    globalThis.fetch = async () => Response.json(body);
    await assert.rejects(api.getAdminEconomy(options), error => error.status === 502);
  }
  for (const body of [{ ...detail, publicId: "0000-0000-0001" },
    { ...detail, economy: { ...economy, ownerPublicId: "0000-0000-0001" } },
    { ...detail, jobStatuses: [{ jobId: "9a272b65-8ada-4b0d-aad8-6a6ef845f41b", status: "ready", storageBlocked: true }] }]) {
    globalThis.fetch = async () => Response.json(body);
    await assert.rejects(api.getAdminEconomyPlayer(publicId), error => error.status === 502);
  }
});

test("economy endpoints preserve forbidden and unavailable errors", async () => {
  for (const status of [401, 403, 503]) {
    globalThis.fetch = async () => Response.json({ code: status === 503 ? "ADMIN_UNAVAILABLE" : "UNAUTHORIZED", message: "Unavailable" }, { status });
    await assert.rejects(api.getAdminEconomyPlayer(publicId), error => error.status === status);
  }
});

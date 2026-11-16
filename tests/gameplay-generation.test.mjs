import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const generation = await vite.ssrLoadModule("/lib/gameplay-generation.ts");
const owner = "AAAA-0000-0001", other = "AAAA-0000-0002";
function memoryStorage() {
  const values = new Map();
  return { values, get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test("normal upgrade preserves generation-zero progress; a reset clears only old gameplay for this account", () => {
  const storage = memoryStorage(), tab = generation.createGameplayGeneration();
  const old = [`zhiv.world-onboarding.v1:${owner}`, `zhiv.app-onboarding.paused.v1:${owner}`,
    `zhiv.trade-ship-arrival.v1:${owner}`,
    `zhiv:game-outbox:v1:${owner}`, `zhiv:game-input:v1:${owner}:queued`,
    `zhiv:forest-memory:v1:${encodeURIComponent(`zhiv:mochlik:presence:${owner}`)}`,
    `zhiv.earth-atlas.v1:${owner}`, `zhiv:construction-goal:v1:${owner}`, `zhiv.section-guide.v1:${owner}:market`,
    `zhiv.clicker-archive.v054:${owner}`, "zhiv.pending-check-in.v2"];
  const preserved = [`zhiv.world-onboarding.v1:${other}`, "zhiv:account-action", "zhiv.pending-bootstrap.v1",
    `zhiv.trade-ship-arrival.v1:${other}`,
    `zhiv:updates:read:v1:${owner}`, `zhiv.earth.location-consent.v1:${owner}`, "zhiv.push-owner.v1"];
  for (const key of [...old, ...preserved]) storage.setItem(key, JSON.stringify({ ownerPublicId: owner, saved: true }));
  assert.equal(tab.adopt(owner, 0, [storage]), true);
  for (const key of old) assert.notEqual(storage.getItem(key), null, "deploy without an explicit reset preserves progress");
  const next = generation.createGameplayGeneration();
  assert.equal(next.adopt(owner, 1, [storage]), true);
  for (const key of old) assert.equal(storage.getItem(key), null, key);
  for (const key of preserved) assert.notEqual(storage.getItem(key), null, key);
  storage.setItem(next.key(`zhiv.world-onboarding.v1:${owner}`), "new course");
  assert.equal(generation.createGameplayGeneration().adopt(owner, 1, [storage]), true);
  assert.equal(storage.getItem(next.key(`zhiv.world-onboarding.v1:${owner}`)), "new course", "ordinary reload retains the new run");
});

test("late saves from an old tab and its pagehide cannot resurrect old state in a new or repeated generation", () => {
  const local = memoryStorage(), oldSession = memoryStorage();
  const old = generation.createGameplayGeneration(), fresh = generation.createGameplayGeneration();
  old.adopt(owner, 0); fresh.adopt(owner, 1, [local, oldSession]);
  const progress = `zhiv:game-outbox:v1:${owner}`;
  local.setItem(old.key(progress), "late old queue");
  oldSession.setItem(old.key("zhiv.pending-check-in.v2"), JSON.stringify({ ownerPublicId: owner }));
  assert.equal(local.getItem(fresh.key(progress)), null);
  assert.equal(oldSession.getItem(fresh.key("zhiv.pending-check-in.v2")), null);
  assert.equal(old.adopt(owner, 1, [local, oldSession]), false, "a live document must reload its module caches");
  assert.equal(old.headers()["X-Game-Generation"], "0", "late requests stay fenced until unload");
  assert.equal(old.key(progress), progress, "late saves keep their original namespace");
  local.setItem(fresh.key(progress), "run one");
  const secondReset = generation.createGameplayGeneration();
  secondReset.adopt(owner, 2, [local, oldSession]);
  assert.equal(local.getItem(fresh.key(progress)), null);
  assert.equal(local.getItem(secondReset.key(progress)), null);
});

test("blocked storage cannot restore old gameplay and a stale rejection cannot block another generation", () => {
  const tab = generation.createGameplayGeneration();
  const unavailable = { get length() { throw new Error("Storage blocked"); } };
  assert.equal(tab.adopt(owner, 4, [unavailable]), true);
  assert.match(tab.key("state"), /:4:state$/);
  assert.equal(tab.reject("GAME_PROGRESS_RESET", { "X-Game-Generation": "3" }), false);
  assert.equal(tab.reject("GAME_SESSION_INACTIVE", tab.headers()), false);
  assert.equal(tab.reject("GAME_PROGRESS_RESET", tab.headers()), true);
  assert.equal(tab.reject("GAME_PROGRESS_RESET", tab.headers()), false, "one reload request per document");
  assert.equal(tab.adopt(owner, 4), false, "even a raced /me cannot reopen a document already rejected by the server");
  assert.throws(() => generation.createGameplayGeneration().adopt(owner, -1));
  assert.throws(() => generation.createGameplayGeneration().adopt(owner, Number.MAX_SAFE_INTEGER + 1));
});

test("real onboarding, tap, reward, discovery and production stores ignore old state even when deletion fails", async () => {
  const storage = memoryStorage();
  storage.removeItem = () => { throw new Error("Removal denied"); };
  const windowBefore = globalThis.window;
  globalThis.window = { localStorage: storage, sessionStorage: storage };
  try { assert.equal(generation.prepareGameplayGeneration(owner, 1), true); }
  finally { if (windowBefore === undefined) delete globalThis.window; else globalThis.window = windowBefore; }
  const { createWorldOnboardingStore } = await vite.ssrLoadModule("/features/world/state/world-onboarding-storage.ts");
  const { createAppOnboardingStore } = await vite.ssrLoadModule("/features/app/onboarding/app-onboarding-storage.ts");
  const { createTradeShipArrivalStore, tradeShipArrivalStorageKey, TRADE_SHIP_ARRIVAL_DURATION } =
    await vite.ssrLoadModule("/features/world/state/trade-ship-arrival-storage.ts");
  const { gameJournalStore } = await vite.ssrLoadModule("/features/game/game-sync-journal.ts");
  const { gameTabInbox } = await vite.ssrLoadModule("/features/game/game-tab-inbox.ts");
  const { createGameRewardsSession } = await vite.ssrLoadModule("/features/game/game-rewards-session.ts");
  const { createEarthAtlasStore } = await vite.ssrLoadModule("/features/earth/earth-atlas-storage.ts");
  const { forestMemoryKey } = await vite.ssrLoadModule("/features/world/state/memory/forest-memory.ts");
  const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
  const { economyCatalog, economyViewSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
  storage.setItem(`zhiv.world-onboarding.v1:${owner}`, JSON.stringify({ version: 2, status: "completed" }));
  storage.setItem(`zhiv.app-onboarding.v2:${owner}`, JSON.stringify({ version: 2, status: "completed" }));
  storage.setItem(`zhiv.app-onboarding.paused.v1:${owner}`, "true");
  storage.setItem(`zhiv:game-outbox:v1:${owner}`, "old queued progress");
  storage.setItem(`zhiv:game-input:v1:${owner}:old`, "old input");
  storage.setItem(`zhiv:game-rewards:pending:v1:${owner}`, JSON.stringify({ requestId: crypto.randomUUID(), ownerPublicId: owner, kind: "daily" }));
  storage.setItem(`zhiv.earth-atlas.v1:${owner}`, JSON.stringify({ version: 1, ids: ["forest"] }));
  const oldShipKey = `zhiv.trade-ship-arrival.v1:${owner}`;
  const oldShip = JSON.stringify({ version: 1, started: true, elapsed: TRADE_SHIP_ARRIVAL_DURATION, hornClaimed: true });
  storage.setItem(oldShipKey, oldShip);
  const forest = `zhiv:mochlik:presence:${owner}`;
  storage.setItem(`zhiv:forest-memory:v1:${encodeURIComponent(forest)}`, "old forest");
  const world = createWorldOnboardingStore(owner, storage), app = createAppOnboardingStore(owner, storage);
  world.restore(); app.restore();
  assert.equal(world.getSnapshot().progress, null);
  assert.equal(app.getSnapshot().progress, null); assert.equal(app.getSnapshot().paused, false);
  const ship = createTradeShipArrivalStore(owner, storage); ship.restore();
  assert.equal(ship.getSnapshot().progress, null, "reset cannot inherit a docked ship or its consumed horn");
  assert.notEqual(tradeShipArrivalStorageKey(owner), oldShipKey);
  ship.start(); ship.checkpoint(5);
  assert.equal(ship.claimHorn(), true, "the new game's introduction owns a new horn contact");
  storage.setItem(oldShipKey, oldShip); // Late pagehide from a pre-reset document.
  ship.restore(); assert.equal(ship.getSnapshot().progress.elapsed, 5, "old-tab saves cannot complete the new introduction");
  assert.equal(gameJournalStore(owner, storage).read(), null);
  assert.equal(gameTabInbox(owner, storage).snapshot(false).pendingTaps, 0);
  assert.equal(storage.getItem(forestMemoryKey(forest)), null, "a null remote snapshot cannot reupload the old local forest");
  const atlas = createEarthAtlasStore(owner, () => storage), stopAtlas = atlas.activate();
  assert.deepEqual(atlas.getSnapshot().ids, []); stopAtlas();
  const rewards = createGameRewardsSession(owner, { get: async () => { throw new Error("offline"); }, send: async () => assert.fail("old reward replayed") }, storage);
  const stopRewards = rewards.activate();
  assert.equal(rewards.getSnapshot().pending, null); stopRewards();

  const snapshot = economyViewSchema.parse({ ownerPublicId: owner, revision: 100, serverTime: "2026-10-22T12:00:00.000Z",
    wallet: { coins: 1000, pearls: 0 }, inventory: { wood: 3, stone: 5 }, buildings: { home: 1, garden: 1, warehouse: 1 },
    storage: { capacity: 50, used: 8, reserved: 0, available: 42, overflow: 0 }, jobs: [],
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, completedExplorations: 0, catalog: economyCatalog });
  storage.setItem(`zhiv:economy:production:v1:${owner}`, JSON.stringify({ version: 1, owner, snapshot,
    entries: [{ requestId: crypto.randomUUID(), targetId: "grow_berries" }] }));
  let sent = 0;
  const economy = createEconomySession(owner, { get: async () => snapshot, send: async () => { sent++; assert.fail("pre-reset intent rebound to new revision"); },
    market: async () => assert.fail(), trade: async () => assert.fail() }, () => assert.fail(), storage,
  { storage, coordinate: async () => () => {} });
  const stop = economy.activate();
  try {
    await economy.refresh();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(economy.getSnapshot().pendingProductionCount, 0); assert.equal(sent, 0);
  } finally { stop(); }
});

test("presence, check-in and mail transports carry generation; a reset response drops the capability and requests one reload", async t => {
  const { getMe, createCheckIn } = await vite.ssrLoadModule("/lib/check-in-api.ts");
  const { sendPresence } = await vite.ssrLoadModule("/features/activity/api.ts");
  const { claimMailGift } = await vite.ssrLoadModule("/features/mailbox/api.ts");
  const { setGamePresence, gamePresenceHeaders } = await vite.ssrLoadModule("/features/activity/transport-state.ts");
  const seen = [], events = [];
  const before = globalThis.window;
  globalThis.window = { dispatchEvent: event => { events.push(event.type); return true; } };
  t.mock.method(globalThis, "fetch", async (path, init) => {
    seen.push([path, init]);
    if (path === "/api/v1/me") return Response.json({ user: { publicId: owner, displayName: "Игрок" },
      lastCheckInAt: null, checkInCount: 0, streak: { currentDays: 0, longestDays: 0, isActive: false, renewBy: null },
      profile: { timeZone: "Europe/Moscow", avatarUrl: null, displayNameChangedAt: null, displayNameChangeAvailableAt: null },
      gameplayGeneration: 1, serverTime: "2026-10-22T12:00:00.000Z" });
    return Response.json({ code: "GAME_PROGRESS_RESET", message: "Началась новая игра" }, { status: 409 });
  });
  try {
    assert.equal((await getMe()).gameplayGeneration, 1);
    setGamePresence(crypto.randomUUID());
    await assert.rejects(sendPresence({ kind: "resume", presenceId: crypto.randomUUID(), sequence: 0, active: true }),
      error => error.body?.code === "GAME_PROGRESS_RESET");
    assert.equal(gamePresenceHeaders()["X-Game-Presence"], undefined);
    setGamePresence("late-success");
    assert.equal(gamePresenceHeaders()["X-Game-Presence"], undefined, "late presence ACK cannot resume a reset document");
    await assert.rejects(createCheckIn(crypto.randomUUID()), error => error.body?.code === "GAME_PROGRESS_RESET");
    await assert.rejects(claimMailGift(owner, crypto.randomUUID()), error => error.body?.code === "GAME_PROGRESS_RESET");
    assert.deepEqual(events, [generation.GAMEPLAY_RESET_EVENT]);
    for (const [, init] of seen) {
      assert.equal(init.headers["X-Game-Generation"], "1");
      assert.equal(init.credentials, "same-origin", "authorization remains attached");
    }
  } finally { if (before === undefined) delete globalThis.window; else globalThis.window = before; }
});

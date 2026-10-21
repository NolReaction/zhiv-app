import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { parseProductionJournal, productionProjection, reserveProduction, safeProductionRecipe, browserJournalCoordinator } = await vite.ssrLoadModule("/features/economy/sync/production-journal.ts");
const { economyCatalog, economyViewSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const owner = "AAAA-0000-0001", time = "2026-10-15T12:00:00.000Z";
const state = () => economyViewSchema.parse({ ownerPublicId: owner, revision: 8, serverTime: time, wallet: { coins: 1000, pearls: 0 },
  inventory: { wood: 3, berries: 3 }, buildings: { home: 5, garden: 3, woodlot: 3, workshop: 3, warehouse: 1, dryer: 3, kiln: 3 },
  productionSlots: { garden: 3, workshop: 3 }, storage: { capacity: 50, used: 6, reserved: 0, available: 44, overflow: 0 }, jobs: [],
  migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, completedExplorations: 0, catalog: economyCatalog });
const intent = targetId => ({ targetId, requestId: crypto.randomUUID() });

test("projection reserves each occupied slot and existing ingredients without adding rewards or progress", () => {
  const base = state(), original = structuredClone(base), recipe = economyCatalog.recipes.find(entry => entry.cost.items.wood === 1 && entry.buildingId === "workshop");
  assert.ok(recipe);
  const entries = [intent(recipe.id), intent(recipe.id), intent(recipe.id)];
  const projected = productionProjection(base, entries);
  assert.equal(projected.inventory.wood, undefined);
  assert.equal(projected.jobs.length, 3);
  assert.equal(reserveProduction(projected, intent(recipe.id)), null, "fourth occupied slot and unconfirmed output are unavailable");
  assert.deepEqual(projected.progression, original.progression);
  assert.deepEqual(projected.inventory, { berries: 3 });
  assert.deepEqual(base, original, "confirmed view is untouched");
  assert.equal(projected.revision, original.revision, "optimistic reservations do not invent revisions");
});

test("fish inputs, quarry, unknown targets and species overrides never enter the local queue", () => {
  const base = state();
  for (const recipe of base.catalog.recipes.filter(recipe => recipe.fishInput || recipe.buildingId === "quarry" || Object.keys(recipe.cost.items).some(id => id === "fish" || id.startsWith("fish_"))))
    assert.equal(safeProductionRecipe(base, recipe.id), null);
  assert.equal(safeProductionRecipe(base, "grow_berries@fish_legendary"), null);
  assert.equal(safeProductionRecipe(base, "unknown"), null);
});

test("unconfirmed output cannot fund another recipe and only existing unlocked recipes reserve", () => {
  const base = state(); base.inventory = {};
  const berry = base.catalog.recipes.find(recipe => recipe.id === "grow_berries");
  assert.ok(berry);
  const next = productionProjection(base, [intent(berry.id)]);
  const compote = base.catalog.recipes.find(recipe => recipe.buildingId === "dryer" && recipe.cost.items.berries > 0);
  assert.ok(compote);
  assert.equal(reserveProduction(next, intent(compote.id)), null);
  const locked = { ...base, buildings: { ...base.buildings, garden: 0 } };
  assert.equal(reserveProduction(locked, intent(berry.id)), null);
});

test("durable journal rejects foreign owner, malformed commands, duplicate ids, sent tails and oversized input", () => {
  const snapshot = state(), head = intent("grow_berries");
  const raw = entries => JSON.stringify({ version: 1, owner, snapshot, entries });
  assert.equal(parseProductionJournal(raw([head]), owner).entries.length, 1);
  assert.equal(parseProductionJournal(raw([head]), "AAAA-0000-0002"), null);
  assert.equal(parseProductionJournal("{" , owner), null);
  assert.equal(parseProductionJournal("x".repeat(2_000_001), owner), null);
  assert.equal(parseProductionJournal(raw([head, head]), owner), null);
  const command = { ...head, ownerPublicId: owner, expectedRevision: 8, action: "start_production", quantity: 1, totalPrice: 0 };
  assert.ok(parseProductionJournal(raw([{ ...head, command }]), owner));
  assert.equal(parseProductionJournal(raw([{ ...head, command: { ...command, action: "claim_job" } }]), owner), null);
  assert.equal(parseProductionJournal(raw([{ ...head, command: { ...command, action: "start_tutorial_harvest" } }]), owner), null,
    "one-time teaching assistance is a confirmed direct command, never deferred production");
  assert.equal(parseProductionJournal(raw([{ ...head, command: { ...command, fishSelection: { fish_epic: 1 } } }]), owner), null);
  assert.equal(parseProductionJournal(raw([head, { ...intent("grow_berries"), command }]), owner), null);
  assert.equal(parseProductionJournal(raw(Array.from({ length: 13 }, () => intent("grow_berries"))), owner), null);
});

test("browser coordination requires an exclusive Web Lock and releases on abort", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let held = false, calls = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: async (_name, options, callback) => {
    calls++; assert.equal(options.ifAvailable, true);
    assert.equal(options.signal, undefined, "the Web Locks specification forbids signal together with ifAvailable");
    if (held) return callback(null);
    held = true;
    try { await callback({ name: "lock" }); } finally { held = false; }
  } } } });
  try {
    const first = new AbortController(), release = await browserJournalCoordinator(owner, first.signal);
    assert.equal(typeof release, "function");
    assert.equal(await browserJournalCoordinator(owner, new AbortController().signal), null);
    first.abort(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(held, false);
    const next = await browserJournalCoordinator(owner, new AbortController().signal); next();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 3);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    assert.equal(await browserJournalCoordinator(owner, new AbortController().signal), null, "no lock support cannot claim durable ownership");
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous); else delete globalThis.navigator;
  }
});


test("saved production transport failures stay in the compact sync status until an ACK", async () => {
  const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
  const cache = new Map();
  const storage = { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value), removeItem: key => cache.delete(key) };
  let sends = 0;
  const base = state();
  const session = createEconomySession(owner, { get: async () => base, market: async () => assert.fail(), trade: async () => assert.fail(), send: async () => {
    if (++sends === 1) throw new Error("Weak network");
    return { state: { ...base, revision: base.revision + 1 }, message: "Производство запущено", acceptedRevision: base.revision + 1, replayed: false };
  } }, () => assert.fail(), undefined, { storage, coordinate: async () => () => {} });
  const stop = session.activate();
  try {
    await session.refresh();
    assert.equal(session.act("start_production", "grow_berries"), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.getSnapshot().pendingProductionCount, 1);
    assert.equal(session.getSnapshot().error, null, "ordinary panels have no large recoverable error plate");
    assert.match(session.getSnapshot().syncError, /сохранены/);
    assert.equal(session.getSnapshot().uncertain, false);
    session.setAvailable(false); session.setAvailable(true);
    await session.retry();
    assert.equal(session.getSnapshot().pendingProductionCount, 0);
    assert.equal(session.getSnapshot().syncError, null);
    assert.equal(session.getSnapshot().error, null);
  } finally { stop(); }
});


test("schema-valid cached recipe durations outside the Date range cannot crash projection", () => {
  const snapshot = state();
  snapshot.catalog = structuredClone(snapshot.catalog);
  snapshot.catalog.recipes.find(recipe => recipe.id === "grow_berries").seconds = Number.MAX_SAFE_INTEGER;
  assert.equal(economyViewSchema.safeParse(snapshot).success, true);
  const entry = intent("grow_berries");
  assert.equal(reserveProduction(snapshot, entry), null);
  assert.doesNotThrow(() => productionProjection(snapshot, [entry]));
  assert.deepEqual(productionProjection(snapshot, [entry]).jobs, []);
});

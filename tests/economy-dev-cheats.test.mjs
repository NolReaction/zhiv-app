import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), initialMode = process.env.NODE_ENV;
const cookieModule = "\0economy-cheats-test-cookie";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root, "next/headers": cookieModule } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "economy-cheats-test-cookie", resolveId(id) { if (id === cookieModule) return id; },
    load(id) { if (id === cookieModule) return "export async function cookies() { return { get() { return { value: globalThis.__economyCheatsTestToken }; } }; }"; } }],
});
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/model.ts");
const { economyDevCommandSchema } = await vite.ssrLoadModule("/features/economy/dev-model.ts");
const { POST } = await vite.ssrLoadModule("/app/api/v1/economy/dev/route.ts");
const { POST: ordinaryPOST } = await vite.ssrLoadModule("/app/api/v1/economy/commands/route.ts");
const now = Date.now();
beforeEach(() => { identities.resetDevStoreForTests(); process.env.NODE_ENV = "development"; delete globalThis.__economyCheatsTestToken; });
after(async () => {
  delete globalThis.__economyCheatsTestToken;
  if (initialMode == null) delete process.env.NODE_ENV; else process.env.NODE_ENV = initialMode;
  await vite.close();
});
function player() { const p = identities.createDevIdentity("Тестовый житель", crypto.randomUUID()); globalThis.__economyCheatsTestToken = p.token; return p; }
const read = p => economy.getDevEconomy(p.token, now);
const command = (p, action = "grant_currency", targetId = "coins", quantity = 100) => ({
  requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, expectedRevision: read(p).revision, action, targetId, quantity: action === "grant_currency" ? quantity * (targetId === "pearls" ? 50 : 10) : quantity, totalPrice: 0,
});
const cheat = (p, action, targetId, quantity = 1) => economy.commandDevEconomyCheat(p.token, command(p, action, targetId, quantity), now);
const normal = (p, action, targetId, quantity = 1, at = now) => economy.commandDevEconomy(p.token, command(p, action, targetId, quantity), at);
function post(body, headers = {}) {
  return new Request("http://localhost:3000/api/v1/economy/dev", { method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
function fixture(p) { read(p); return globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId); }

test("DEV currency and item grants return the real snapshot, preserve normal commands and replay once", async () => {
  const p = player(), cmd = command(p);
  const response = await POST(post(cmd)), result = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(model.economyResultSchema.safeParse(result).success, true);
  assert.equal(result.state.wallet.coins, 1000); assert.equal(result.acceptedRevision, cmd.expectedRevision + 1);
  const replay = economy.commandDevEconomyCheat(p.token, { ...cmd, requestId: cmd.requestId.toUpperCase() }, now);
  assert.equal(replay.replayed, true); assert.equal(replay.state.wallet.coins, 1000); assert.equal(replay.state.revision, cmd.expectedRevision + 1);
  assert.throws(() => economy.commandDevEconomyCheat(p.token, { ...cmd, quantity: 200 }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
  cheat(p, "grant_currency", "pearls", 25);
  const granted = cheat(p, "grant_item", "berries", 400).state;
  assert.equal(granted.wallet.pearls, 1250); assert.equal(granted.inventory.berries, 400);
  assert.equal(granted.storage.overflow, 200, "DEV grants explicitly permit storage overflow");
  const sold = normal(p, "sell", "berries", 10).state;
  assert.equal(sold.inventory.berries, 390); assert.equal(sold.storage.overflow, 190);
  assert.ok(sold.wallet.coins > granted.wallet.coins);
});

test("DEV pearl grant notices use the visible denomination while balances and replay stay in stored units", () => {
  const p = player(), cmd = command(p, "grant_currency", "pearls", 100);
  assert.equal(cmd.quantity, 5000);
  const result = economy.commandDevEconomyCheat(p.token, cmd, now);
  assert.equal(result.message.replace(/\u00a0|\u202f/g, " "), "DEV: выдано 2 500 жемчужин");
  assert.equal(result.state.wallet.pearls, 5000);
  const replay = economy.commandDevEconomyCheat(p.token, cmd, now);
  assert.equal(replay.replayed, true);
  assert.equal(replay.message, result.message);
  assert.equal(replay.state.wallet.pearls, 5000);
  assert.throws(() => economy.commandDevEconomyCheat(p.token, { ...command(p, "grant_currency", "pearls"), quantity: 51 }, now),
    { code: "INVALID_ECONOMY_COMMAND", message: "Количество валюты должно быть кратно 25" });
  assert.equal(read(p).wallet.pearls, 5000);
});

test("DEV API requires development, account, trusted origin, JSON and a bounded body", async () => {
  assert.equal((await POST(post({}))).status, 401);
  const p = player(), cmd = command(p), before = read(p);
  for (const headers of [{ Origin: "https://evil.example" }, { "Sec-Fetch-Site": "cross-site" }])
    assert.equal((await POST(post(cmd, headers))).status, 403);
  assert.equal((await POST(post(cmd, { "Content-Type": "text/plain" }))).status, 415);
  assert.equal((await POST(post(" ".repeat(4097)))).status, 413);
  assert.equal((await POST(post(cmd, { "Content-Length": "4097" }))).status, 413);
  for (const mode of ["test", "production", ""]) {
    process.env.NODE_ENV = mode;
    const response = await POST(post(cmd)); assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "DEV_API_DISABLED");
    assert.throws(() => economy.commandDevEconomyCheat(p.token, cmd, now), { code: "DEV_TOOLS_DISABLED" });
  }
  assert.deepEqual(read(p), before);
});

test("DEV commands cannot enter ordinary gameplay endpoints or reuse an ordinary receipt", async () => {
  const p = player(), cmd = command(p);
  assert.equal(model.economyCommandSchema.safeParse(cmd).success, false);
  assert.equal((await ordinaryPOST(post(cmd))).status, 400);
  assert.throws(() => economy.commandDevEconomy(p.token, cmd, now), { code: "INVALID_ECONOMY_COMMAND" });
  const ordinary = command(p, "start_production", "grow_berries", 1);
  economy.commandDevEconomy(p.token, ordinary, now);
  assert.throws(() => economy.commandDevEconomyCheat(p.token, { ...cmd, requestId: ordinary.requestId }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
  assert.equal(read(p).wallet.coins, 0); assert.equal(read(p).jobs.length, 1);
});

test("bad actions, items, quantities, zero-level homes and extra fields cannot mutate the snapshot", async () => {
  const p = player(), base = command(p), before = read(p);
  const invalid = [null, [], { ...base, action: "erase_save" }, { ...base, action: "grant_item", targetId: "__proto__" },
    { ...base, targetId: "sparks" }, { ...base, quantity: 0 }, { ...base, quantity: -1 }, { ...base, quantity: 1.5 },
    { ...base, quantity: 10_000_001 }, { ...base, quantity: "100" }, { ...base, totalPrice: 1 }, { ...base, extra: true },
    { ...base, action: "finish_jobs", targetId: "market", quantity: 1 }, { ...base, action: "finish_jobs", targetId: "all", quantity: 2 },
    { ...base, action: "set_building_level", targetId: "home", quantity: 0 },
    { ...base, action: "set_building_level", targetId: "warehouse", quantity: 0 },
    { ...base, action: "set_building_level", targetId: "no-building", quantity: 1 },
    { ...base, action: "grant_upgrade_cost", targetId: "workshop", quantity: 2 }];
  for (const input of invalid) {
    assert.equal(economyDevCommandSchema.safeParse(input).success, false);
    assert.equal((await POST(post(input))).status, 400);
  }
  assert.equal((await POST(post("{broken"))).status, 400);
  assert.deepEqual(read(p), before);
});

test("owner switches and stale revisions fail before any change and do not poison the retry ID", () => {
  const p = player(), other = player(), stale = command(p), before = read(p);
  assert.throws(() => economy.commandDevEconomyCheat(undefined, stale, now), { code: "UNAUTHORIZED" });
  assert.throws(() => economy.commandDevEconomyCheat(other.token, stale, now), { code: "ECONOMY_OWNER_CHANGED" });
  assert.deepEqual(read(p), before);
  cheat(p, "grant_currency", "coins", 1);
  assert.throws(() => economy.commandDevEconomyCheat(p.token, stale, now), { code: "ECONOMY_REVISION_CONFLICT" });
  const fixed = economy.commandDevEconomyCheat(p.token, { ...stale, expectedRevision: read(p).revision }, now);
  assert.equal(fixed.state.wallet.coins, 1010); assert.equal(fixed.replayed, false);
});

test("numeric overflow including market escrow is atomic and records no successful receipt", () => {
  const p = player(), row = fixture(p);
  row.state.wallet.coins = model.ECONOMY_MAX_BALANCE;
  row.state.wallet.pearls = model.ECONOMY_MAX_PEARLS;
  row.state.inventory.wood = model.ECONOMY_MAX_ITEMS - 2;
  globalThis.__zhivDevEconomyStore.listings.set("reserved", { id: "reserved", sellerPublicId: p.me.user.publicId,
    itemId: "wood", quantity: 2, totalPrice: 4, status: "active", createdAt: new Date(now).toISOString(), closedAt: null });
  const before = read(p), receipts = row.receipts.size;
  for (const [action, targetId] of [["grant_currency", "coins"], ["grant_currency", "pearls"], ["grant_item", "wood"]])
    assert.throws(() => cheat(p, action, targetId), { code: "ECONOMY_CAPACITY" });
  assert.deepEqual(read(p), before); assert.equal(row.receipts.size, receipts);
  row.revision = Number.MAX_SAFE_INTEGER - 1;
  const last = cheat(p, "grant_item", "berries").state; assert.equal(last.revision, Number.MAX_SAFE_INTEGER);
  const exhausted = { ...command(p, "grant_item", "berries", 1), expectedRevision: Number.MAX_SAFE_INTEGER - 1 };
  assert.throws(() => economy.commandDevEconomyCheat(p.token, exhausted, now), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.equal(read(p).inventory.berries, 1);
});

test("upgrade cost grants only the missing cost and leave prerequisite buildings and paid work intact", () => {
  const p = player(), row = fixture(p);
  const home = model.economyCatalog.buildings.find(building => building.id === "home").levels.find(level => level.level === 2);
  row.state.wallet.coins = home.cost.coins + 500;
  row.state.inventory = { wood: 500 };
  const expected = { ...row.state.inventory };
  for (const [item, amount] of Object.entries(home.cost.items)) expected[item] = Math.max(expected[item] ?? 0, amount);
  const before = read(p), granted = cheat(p, "grant_upgrade_cost", "home").state;
  assert.deepEqual(granted.inventory, expected); assert.equal(granted.wallet.coins, before.wallet.coins);
  assert.deepEqual(granted.buildings, before.buildings);
  assert.throws(() => normal(p, "start_construction", "home"), { code: "ECONOMY_BUILDING_REQUIRED" });
  assert.deepEqual(cheat(p, "grant_upgrade_cost", "home").state.inventory, expected, "repeated grants do not accumulate ingredients");
  cheat(p, "set_building_level", "home", 5);
  const max = read(p);
  assert.throws(() => cheat(p, "grant_upgrade_cost", "home"), { code: "ECONOMY_MAX_LEVEL" });
  assert.deepEqual(read(p), max);
});

test("instant building levels use catalog bounds, can bypass gates and preserve unrelated jobs and market", () => {
  const p = player(), production = normal(p, "start_production", "grow_berries").state.jobs[0];
  for (const building of model.economyCatalog.buildings) {
    const maximum = Math.max(...building.levels.map(level => level.level));
    if (building.id !== "garden") {
      assert.equal(cheat(p, "set_building_level", building.id, maximum).state.buildings[building.id], maximum);
      const minimum = ["home", "warehouse"].includes(building.id) ? 1 : 0;
      assert.equal(cheat(p, "set_building_level", building.id, minimum).state.buildings[building.id], minimum);
    }
    assert.throws(() => cheat(p, "set_building_level", building.id, maximum + 1), { code: "INVALID_ECONOMY_COMMAND" });
  }
  const before = read(p);
  assert.throws(() => cheat(p, "set_building_level", "garden", 0), { code: "ECONOMY_BUILDING_BUSY" });
  assert.deepEqual(read(p), before); assert.deepEqual(read(p).jobs, [production]);
  assert.equal(cheat(p, "set_building_level", "quarry", 1).state.buildings.home, 1, "DEV may inspect locked scenery without changing the house");
  cheat(p, "set_building_level", "home", 2);
  const row = fixture(p); row.state.completedExplorations = 1;
  cheat(p, "grant_item", "wood", 3);
  const listing = economy.commandDevEconomyMarket(p.token, { ...command(p, "create_listing", "wood", 2), totalPrice: 80 }, now).listing;
  cheat(p, "set_building_level", "home", 1);
  assert.equal(globalThis.__zhivDevEconomyStore.listings.get(listing.id).status, "active");
  assert.equal(read(p).storage.reserved, 2); assert.deepEqual(read(p).jobs, [production]);
});

test("DEV storage controls grant every relic upgrade through level 10 without changing home or other buildings", () => {
  const p = player(), warehouse = model.economyCatalog.buildings.find(building => building.id === "warehouse");
  assert.equal(Math.max(...warehouse.levels.map(level => level.level)), 10);
  const ordinaryBuildings = structuredClone(read(p).buildings);
  for (const target of warehouse.levels.filter(level => level.level >= 4)) {
    const previous = cheat(p, "set_building_level", "warehouse", target.level - 1).state;
    const row = fixture(p); row.state.inventory = {};
    const granted = cheat(p, "grant_upgrade_cost", "warehouse").state;
    assert.deepEqual(granted.inventory, target.cost.items, `missing relic set for storage ${target.level}`);
    assert.deepEqual(granted.wallet, previous.wallet, "relic-only expansion adds no coins or pearls");
    assert.deepEqual(granted.buildings, { ...ordinaryBuildings, warehouse: target.level - 1 });
    const repeated = cheat(p, "grant_upgrade_cost", "warehouse").state;
    assert.deepEqual(repeated.inventory, granted.inventory, "cost grants are missing-only even for relic sets");
    const construction = normal(p, "start_construction", "warehouse").state.jobs.find(job => job.kind === "construction");
    assert.equal(construction.targetLevel, target.level);
    cheat(p, "finish_jobs", "construction");
    const finished = normal(p, "claim_job", construction.id).state;
    assert.equal(finished.buildings.warehouse, target.level);
    assert.equal(finished.storage.capacity, target.warehouseCapacity);
    assert.deepEqual(finished.buildings, { ...ordinaryBuildings, warehouse: target.level });
  }
  assert.throws(() => cheat(p, "set_building_level", "warehouse", 11), { code: "INVALID_ECONOMY_COMMAND" });
  assert.throws(() => cheat(p, "grant_upgrade_cost", "warehouse"), { code: "ECONOMY_MAX_LEVEL" });
});

test("finishing jobs preserves paid snapshots and requires ordinary claims for rewards and construction", () => {
  const p = player();
  const production = normal(p, "start_production", "grow_berries").state.jobs[0];
  const exploration = normal(p, "start_exploration", "forest").state.jobs.find(job => job.kind === "exploration");
  cheat(p, "grant_upgrade_cost", "woodlot");
  const construction = normal(p, "start_construction", "woodlot").state.jobs.find(job => job.kind === "construction");
  const before = read(p);
  const ready = cheat(p, "finish_jobs", "construction").state;
  assert.equal(ready.buildings.woodlot, 0); assert.deepEqual(ready.wallet, before.wallet); assert.deepEqual(ready.inventory, before.inventory);
  assert.deepEqual(ready.jobs.find(job => job.kind === "construction"), { ...construction, finishesAt: new Date(now).toISOString() });
  assert.deepEqual(ready.jobs.find(job => job.kind === "production"), production);
  assert.deepEqual(ready.jobs.find(job => job.kind === "exploration"), exploration);
  assert.throws(() => cheat(p, "set_building_level", "woodlot", 2), { code: "ECONOMY_BUILDING_BUSY" });
  assert.equal(normal(p, "claim_job", construction.id).state.buildings.woodlot, 1);
  const all = cheat(p, "finish_jobs", "all").state;
  assert.equal(all.completedExplorations, 0); assert.equal(all.jobs.length, 2);
  assert.ok(all.jobs.every(job => job.finishesAt === new Date(now).toISOString()));
  const collecting = normal(p, "start_collection", production.id).state.jobs.find(job => job.id === production.id);
  normal(p, "claim_job", production.id, 1, Date.parse(collecting.collection.finishesAt));
  const claimed = normal(p, "claim_job", exploration.id).state;
  assert.equal(claimed.completedExplorations, 1); assert.equal(claimed.jobs.length, 0);
  for (const [item, amount] of Object.entries(exploration.rewards)) assert.ok(claimed.inventory[item] >= amount);
  assert.throws(() => cheat(p, "finish_jobs", "all"), { code: "ECONOMY_DEV_NO_JOBS" });
  assert.deepEqual(read(p), claimed);
});

test("DEV command defaults still produce a strict, ordinary result-compatible request", () => {
  const p = player(), input = command(p, "finish_jobs", "production", 1);
  delete input.quantity; delete input.totalPrice;
  assert.deepEqual(economyDevCommandSchema.parse(input), { ...input, quantity: 1, totalPrice: 0 });
});

test("settlement scenarios fill a home tier, cap independent storage at that tier and preserve owned assets", async () => {
  const { economyDevSettlement } = await vite.ssrLoadModule("/features/economy/dev-presets.ts");
  const p = player(), row = fixture(p);
  row.state.inventory = { ancient_core: 2, wood: 37 };
  row.state.wallet = { coins: 7000, pearls: 500 };
  row.state.fishing.catches = { fish: 7 };
  const assets = structuredClone({ inventory: row.state.inventory, wallet: row.state.wallet, fishing: row.state.fishing });
  for (const tier of [2, 3, 4, 5, 1]) {
    const input = command(p, "apply_settlement", "home", tier);
    assert.equal(model.economyCommandSchema.safeParse(input).success, false, "presets must never become player commands");
    const result = economy.commandDevEconomyCheat(p.token, input, now);
    assert.equal(result.state.buildings.home, tier);
    assert.equal(result.state.buildings.warehouse, tier, "a home preset must not grant the whole independent storage ladder");
    assert.deepEqual(result.state.buildings, economyDevSettlement(tier));
    for (const building of model.economyCatalog.buildings.filter(building => building.id !== "home")) {
      const level = building.levels.find(level => level.level === result.state.buildings[building.id]);
      if (level) {
        assert.ok(level.requiredHomeLevel <= tier);
        for (const [id, minimum] of Object.entries(level.requiredBuildings)) assert.ok(result.state.buildings[id] >= minimum);
      }
      const next = building.levels.find(level => level.level === result.state.buildings[building.id] + 1);
      if (next) assert.ok((building.id === "warehouse" && next.level > tier) || next.requiredHomeLevel > tier || Object.entries(next.requiredBuildings).some(([id, minimum]) => result.state.buildings[id] < minimum), "every reachable non-storage upgrade is included");
    }
    assert.deepEqual({ inventory: result.state.inventory, wallet: result.state.wallet, fishing: result.state.fishing }, assets);
    const replay = economy.commandDevEconomyCheat(p.token, input, now);
    assert.equal(replay.replayed, true);
    assert.equal(replay.state.revision, result.state.revision);
  }
});

test("settlement preset cannot erase pending production, exploration or ready rewards", () => {
  const p = player();
  normal(p, "start_production", "grow_berries");
  const before = read(p);
  assert.throws(() => cheat(p, "apply_settlement", "home", 3), { code: "ECONOMY_BUILDING_BUSY" });
  assert.deepEqual(read(p), before);
  cheat(p, "finish_jobs", "all");
  assert.throws(() => cheat(p, "apply_settlement", "home", 3), { code: "ECONOMY_BUILDING_BUSY" });
  const collecting = normal(p, "start_collection", read(p).jobs[0].id).state.jobs[0];
  normal(p, "claim_job", collecting.id, 1, Date.parse(collecting.collection.finishesAt));
  assert.equal(cheat(p, "apply_settlement", "home", 3).state.buildings.home, 3);
  for (const quantity of [0, 6]) assert.equal(economyDevCommandSchema.safeParse(command(p, "apply_settlement", "home", quantity)).success, false);
  assert.equal(economyDevCommandSchema.safeParse(command(p, "apply_settlement", "warehouse", 2)).success, false);
});


test("DEV gear grants add permanent ownership atomically without stock, catches, selection or purchase rewards", async () => {
  const p = player(), before = read(p), input = command(p, "grant_fishing_gear", "all", 1);
  assert.equal(model.economyCommandSchema.safeParse(input).success, false);
  assert.equal((await ordinaryPOST(post(input))).status, 400);
  const response = await POST(post(input)); assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.state.fishing.ownedRods, model.economyCatalog.fishing.rods.map(rod => rod.id));
  assert.deepEqual(result.state.fishing.ownedHooks, model.economyCatalog.fishing.hooks.map(hook => hook.id));
  assert.equal(result.state.fishing.equippedRodId, before.fishing.equippedRodId);
  assert.equal(result.state.fishing.equippedHookId, before.fishing.equippedHookId);
  assert.deepEqual(result.state.fishing.catches, before.fishing.catches);
  assert.deepEqual(result.state.inventory, before.inventory);
  assert.deepEqual(result.state.wallet, before.wallet);
  assert.deepEqual(result.state.fishingShop, before.fishingShop, "DEV ownership must not buy up or reroll the merchant");
  const replay = economy.commandDevEconomyCheat(p.token, input, now);
  assert.equal(replay.replayed, true); assert.equal(replay.acceptedRevision, result.acceptedRevision);
  const repeated = cheat(p, "grant_fishing_gear", "all").state;
  assert.deepEqual(repeated.fishing, result.state.fishing, "a new receipt still cannot duplicate permanent gear");
  for (const target of ["wood", "fish", "worm_bait", "__proto__"])
    assert.equal(economyDevCommandSchema.safeParse(command(p, "grant_fishing_gear", target, 1)).success, false);
  assert.equal(economyDevCommandSchema.safeParse(command(p, "grant_fishing_gear", "all", 2)).success, false);
  process.env.NODE_ENV = "production";
  assert.equal((await POST(post(command(p, "grant_fishing_gear", "all", 1)))).status, 503);
});

test("individual DEV gear grants preserve paid trips and fish grants do not fake collection discoveries", () => {
  const p = player();
  const trip = normal(p, "start_fishing", "shore").state.jobs[0];
  const granted = cheat(p, "grant_fishing_gear", "leviathan_hook").state;
  assert.deepEqual(granted.fishing.ownedHooks, ["bare_hook", "leviathan_hook"]);
  assert.deepEqual(granted.fishing.ownedRods, ["reed_rod"]);
  assert.deepEqual(granted.jobs[0], trip, "granting better tackle does not rewrite an already paid draw");
  for (const id of ["fish_shark", "fish", "firefly_bait"]) cheat(p, "grant_item", id, 3);
  const state = read(p);
  assert.equal(state.inventory.fish_shark, 3); assert.equal(state.inventory.fish, 3); assert.equal(state.inventory.firefly_bait, 3);
  assert.deepEqual(state.fishing.catches, {});
  assert.equal(state.completedExplorations, 0);
});


test("DEV cannot remove or change an occupied mine until its actor delivery is claimed", () => {
  const p = player();
  cheat(p, "apply_settlement", "home", 2);
  normal(p, "start_exploration", "quarry_stone");
  const before = read(p);
  assert.throws(() => cheat(p, "set_building_level", "quarry", 0), { code: "ECONOMY_BUILDING_BUSY" });
  assert.deepEqual(read(p), before);
  cheat(p, "finish_jobs", "exploration");
  assert.throws(() => cheat(p, "set_building_level", "quarry", 0), { code: "ECONOMY_BUILDING_BUSY" });
  normal(p, "claim_job", before.jobs[0].id);
  assert.equal(cheat(p, "set_building_level", "quarry", 0).state.buildings.quarry, 0);
});

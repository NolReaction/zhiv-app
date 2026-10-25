import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), previousMode = process.env.NODE_ENV, previousSecret = process.env.DEV_ADMIN_PASSWORD;
const cookieModule = "\0local-admin-cookie";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root, "next/headers": cookieModule } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "local-admin-cookie", resolveId(id) { if (id === cookieModule) return id; }, load(id) {
    if (id === cookieModule) return "export async function cookies() { return { get() { return { value: globalThis.__localAdminToken }; } }; }";
  } }],
});
const identity = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const access = await vite.ssrLoadModule("/lib/dev/admin-access.ts");
const admin = await vite.ssrLoadModule("/lib/dev/admin-store.ts");
const neighbor = await vite.ssrLoadModule("/lib/dev/neighbor-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/neighbor-model.ts");
const route = await vite.ssrLoadModule("/app/api/v1/admin/[...path]/route.ts");
const secret = crypto.randomUUID(), wrongCode = crypto.randomUUID();
const origin = "http://172.20.10.13:3000";
const req = (path, body, headers = {}) => new Request(`${origin}/api/v1/admin/${path}`, { method: body === undefined ? "GET" : "POST",
  headers: { Host: "172.20.10.13:3000", ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: origin }), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const get = path => route.GET(req(path));
const post = (path, body) => route.POST(req(path, body));
function player(name = "Игрок") {
  const result = identity.createDevIdentity(name, crypto.randomUUID());
  economy.getDevEconomy(result.token);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(result.me.user.publicId);
  Object.assign(row.state.buildings, { home: 2, bridge: 1, warehouse: 6 });
  row.state.completedExplorations = 1; row.state.inventory = { wood: 20, stone: 20, fiber: 20 }; row.state.wallet.coins = 10000;
  return result;
}
async function unlock(owner) {
  globalThis.__localAdminToken = owner.token;
  const result = await post("local/unlock", { password: secret }); assert.equal(result.status, 200);
}
beforeEach(() => {
  process.env.NODE_ENV = "test"; process.env.DEV_ADMIN_PASSWORD = secret;
  identity.resetDevStoreForTests(); access.resetDevAdminAccessForTests(); admin.resetDevAdminStoreForTests(); delete globalThis.__localAdminToken;
});
after(async () => {
  if (previousMode == null) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
  if (previousSecret == null) delete process.env.DEV_ADMIN_PASSWORD; else process.env.DEV_ADMIN_PASSWORD = previousSecret;
  delete globalThis.__localAdminToken; await vite.close();
});

test("LAN administration requires a real session and explicit code, never grants another session or production access", async () => {
  assert.equal((await get("access")).status, 401);
  const owner = player(); globalThis.__localAdminToken = owner.token;
  assert.equal((await get("access")).status, 403);
  assert.equal((await post("local/unlock", { password: wrongCode })).status, 403);
  await unlock(owner);
  const result = await get("access"), body = await result.json();
  assert.equal(result.status, 200); assert.equal(body.mode, "local"); assert.equal(body.publicId, owner.me.user.publicId);
  assert.equal(JSON.stringify(body).includes(secret), false); assert.equal(result.headers.get("Cache-Control"), "no-store");
  const secondSession = identity.createDevIdentity("Другой", crypto.randomUUID()); globalThis.__localAdminToken = secondSession.token;
  assert.equal((await get("neighbor")).status, 403);
  globalThis.__localAdminToken = owner.token;
  process.env.NODE_ENV = "production";
  assert.equal((await get("access")).status, 503); assert.equal((await post("local/unlock", { password: secret })).status, 503);
  assert.equal(access.devAdminAllowed(owner.token), false);
});

test("local grants cannot transfer to a fresh login of the same account or survive session revocation", async () => {
  const bootstrap = crypto.randomUUID(), owner = identity.createDevIdentity("Админ", bootstrap);
  await unlock(owner);
  const next = identity.createDevIdentity("Админ", bootstrap);
  assert.equal(next.me.user.publicId, owner.me.user.publicId);
  globalThis.__localAdminToken = next.token; assert.equal((await get("access")).status, 403);
  globalThis.__localAdminToken = owner.token;
  globalThis.__zhivDevStore.sessions.delete(owner.token);
  assert.equal((await get("access")).status, 401);
});

test("admin guards accept real browser same-origin metadata and reject cross-site, missing proof and forwarded spoofing", async () => {
  const owner = player(); await unlock(owner);
  for (const headers of [{ Origin: "https://attacker.example" }, { Origin: "null", "Sec-Fetch-Site": "same-origin" },
    { Origin: "http://localhost:3000", "Sec-Fetch-Site": "same-origin" }, { "Sec-Fetch-Site": "cross-site" },
    { Host: "public.example", "X-Forwarded-Host": "172.20.10.13:3000" }, { Origin: "http://localhost:3000", "X-Forwarded-Host": "localhost:3000" }]) {
    assert.equal((await route.POST(req("local/lock", {}, headers))).status, 403);
  }
  const withoutOrigin = req("local/lock", {}); withoutOrigin.headers.delete("origin");
  assert.equal((await route.POST(withoutOrigin)).status, 403);
  assert.equal((await get("access")).status, 200);
  assert.equal((await route.POST(req("local/unlock", { password: secret }, { "Content-Length": "99999" }))).status, 413);
  // Actual Chromium/Next POST headers: same-origin metadata without an Origin header.
  const browser = req("local/unlock", { password: secret }, { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", Referer: `${origin}/admin` });
  browser.headers.delete("origin");
  assert.equal((await route.POST(browser)).status, 200);
});

test("local unlock limits guesses, requires configured code and revokes on lock or code rotation", async () => {
  const owner = player(); globalThis.__localAdminToken = owner.token;
  for (let index = 0; index < 5; index++) assert.equal((await post("local/unlock", { password: wrongCode })).status, 403);
  assert.equal((await post("local/unlock", { password: secret })).status, 429);
  access.resetDevAdminAccessForTests(); await unlock(owner);
  assert.equal((await post("local/lock", {})).status, 200); assert.equal((await get("access")).status, 403);
  await unlock(owner); process.env.DEV_ADMIN_PASSWORD = crypto.randomUUID();
  assert.equal((await get("access")).status, 403);
  delete process.env.DEV_ADMIN_PASSWORD;
  assert.equal((await post("local/unlock", { password: secret })).status, 503);
});

test("settings validate version, immutable replay body, safe gear and preserve already frozen daily stock", async () => {
  const owner = player(); await unlock(owner);
  const offers = economy.getDevEconomyNeighbor(owner.token).shop.offers;
  const before = await (await get("neighbor")).json(); assert.equal(model.neighborAdminViewSchema.safeParse(before).success, true);
  const command = { requestId: crypto.randomUUID(), expectedVersion: before.version, reason: "Проверка настроек соседа",
    settings: { ...before.settings, name: "Берест тестовый", autoBuyEnabled: false, offerQuantity: 2 } };
  const saved = await (await post("neighbor/settings", command)).json();
  assert.equal(saved.settings.name, command.settings.name); assert.equal(saved.version, before.version + 1);
  assert.equal(saved.receipt.replayed, false); assert.equal(model.neighborAdminViewSchema.safeParse(saved).success, true);
  assert.deepEqual(economy.getDevEconomyNeighbor(owner.token).shop.offers, offers);
  const replay = await (await post("neighbor/settings", command)).json(); assert.equal(replay.receipt.replayed, true); assert.equal(replay.version, saved.version);
  assert.equal((await post("neighbor/settings", { ...command, settings: { ...command.settings, name: "Подмена" } })).status, 409);
  assert.equal((await post("neighbor/settings", { ...command, requestId: crypto.randomUUID() })).status, 409);
  assert.equal((await post("neighbor/settings", { ...command, requestId: crypto.randomUUID(), expectedVersion: saved.version,
    settings: { ...command.settings, equipment: { ...command.settings.equipment, head: "unknown_item" } } })).status, 400);
  assert.equal((await get("audit")).status, 200);
  assert.equal((await (await get("audit")).json()).total, 1);
});

test("revoking local administrator while a request body is arriving prevents the later commit", async () => {
  const owner = player(); await unlock(owner);
  const before = await (await get("neighbor")).json();
  const body = { requestId: crypto.randomUUID(), expectedVersion: before.version, reason: "Проверка отзыва доступа",
    settings: { ...before.settings, name: "Не должно сохраниться" } };
  let release, arrived;
  const reading = new Promise(resolve => { arrived = resolve; });
  const stream = new ReadableStream({ pull(controller) {
    arrived();
    return new Promise(resolve => { release = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close(); resolve(); }; });
  } }, { highWaterMark: 0 });
  const request = new Request(`${origin}/api/v1/admin/neighbor/settings`, { method: "POST", body: stream, duplex: "half",
    headers: { Host: "172.20.10.13:3000", Origin: origin, "Content-Type": "application/json" } });
  const pending = route.POST(request); await reading;
  access.lockDevAdmin(owner.token); release();
  assert.equal((await pending).status, 403);
  assert.equal(neighbor.devNeighborSettings().name, before.settings.name);
  assert.equal(neighbor.devNeighborVersion(), before.version);
  assert.equal(admin.getDevAdminAudit(0, 25).total, 0);
});

test("manual local purchase settles actual listing once with usual fee and budgets while automation is paused", async () => {
  const owner = player("Администратор"), seller = player("Продавец"); await unlock(owner);
  neighbor.configureDevNeighbor({ ...model.neighborDefaultSettings, autoBuyEnabled: false });
  const listing = economy.commandDevEconomyMarket(seller.token, { requestId: crypto.randomUUID(), ownerPublicId: seller.me.user.publicId,
    expectedRevision: economy.getDevEconomy(seller.token).revision, action: "create_listing", targetId: "wood", quantity: 1, totalPrice: 30 }).listing;
  const snapshot = await (await get(`neighbor?publicId=${seller.me.user.publicId}`)).json();
  assert.equal(snapshot.pending.length, 1); assert.equal(snapshot.pending[0].eligible, true);
  const command = { requestId: crypto.randomUUID(), playerPublicId: seller.me.user.publicId, listingId: listing.id, expectedTotalPrice: 30, reason: "Ручная проверка первой продажи" };
  const result = await (await post("neighbor/buy", command)).json();
  assert.equal(result.receipt.replayed, false); assert.equal(result.pending.length, 0); assert.equal(result.usage.usedLots, 1);
  assert.equal(result.history[0].source, "manual"); assert.equal(result.history[0].requestId, command.requestId);
  assert.equal(result.history[0].proceedsCoins, snapshot.pending[0].proceedsCoins);
  assert.equal((await (await post("neighbor/buy", command)).json()).receipt.replayed, true);
  assert.equal((await (await get(`neighbor?publicId=${seller.me.user.publicId}`)).json()).usage.usedLots, 1);
  assert.equal((await post("neighbor/buy", { ...command, requestId: crypto.randomUUID() })).status, 409);
  const sale = economy.getDevEconomyMarket(seller.token, {}).mine.find(row => row.id === listing.id).sale;
  assert.equal(sale.buyerKind, "world_character"); assert.equal(sale.claimedAt, null);
  assert.equal(sale.proceedsCoins, snapshot.pending[0].proceedsCoins);
  assert.equal((await (await get("local/players")).json()).players.length, 2);
  assert.equal((await (await get("audit")).json()).total, 1);
});

test("local neighbor inspection never initializes another player's economy and unsupported administration remains closed", async () => {
  const owner = player(); await unlock(owner);
  const other = identity.createDevIdentity("Без хозяйства", crypto.randomUUID()), count = globalThis.__zhivDevEconomyStore.profiles.size;
  const view = await (await get(`neighbor?publicId=${other.me.user.publicId}`)).json();
  assert.equal(view.player.publicId, other.me.user.publicId); assert.equal(view.pending.length, 0);
  assert.equal(globalThis.__zhivDevEconomyStore.profiles.size, count);
  assert.equal((await get("neighbor?unknown=value")).status, 400);
  assert.equal((await get("monitoring")).status, 503); assert.equal((await post("users/someone/manage", {})).status, 503);
});


test("admin saves and applies a 3000-coin lot with increased budgets without replaying settlement", async () => {
  const owner = player(); await unlock(owner);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(owner.me.user.publicId);
  row.state.buildings.home = 5; row.state.inventory = { wood: 99 };
  const initial = await (await get("neighbor")).json();
  const settingsCommand = { requestId: crypto.randomUUID(), expectedVersion: initial.version, reason: "Расширение ручного выкупа",
    settings: { ...initial.settings, maxLotsPerDay: 20, dailyBudgetCoins: 100000, maxLotCoins: 3000,
      globalDailyBudgetCoins: 1000000, firstDelaySeconds: 0, staleAfterSeconds: 0, buyPriceBps: 20000 } };
  const saved = await post("neighbor/settings", settingsCommand);
  assert.equal(saved.status, 200); assert.equal((await saved.json()).settings.maxLotCoins, 3000);
  const view = economy.getDevEconomy(owner.token);
  const lot = economy.commandDevEconomyMarket(owner.token, { requestId: crypto.randomUUID(), ownerPublicId: owner.me.user.publicId,
    expectedRevision: view.revision, action: "create_listing", targetId: "wood", quantity: 99, totalPrice: 3000 }).listing;
  const command = { requestId: crypto.randomUUID(), listingId: lot.id, playerPublicId: owner.me.user.publicId,
    expectedTotalPrice: 3000, reason: "Проверка большого лота" };
  const response = await post("neighbor/buy", command), first = await response.json();
  assert.equal(response.status, 200); assert.equal(first.history.length, 1);
  assert.equal(first.history[0].totalPrice, 3000); assert.equal(first.history[0].proceedsCoins, 2850);
  const replay = await (await post("neighbor/buy", command)).json();
  assert.equal(replay.receipt.replayed, true); assert.equal(replay.history.length, 1);
  const state = await (await get("neighbor?publicId=" + owner.me.user.publicId)).json();
  assert.equal(state.usage.spentCoins, 3000); assert.equal(state.usage.usedLots, 1);
});

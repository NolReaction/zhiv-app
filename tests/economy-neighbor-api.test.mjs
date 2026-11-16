import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), initialMode = process.env.NODE_ENV;
const cookieModule = "\0neighbor-test-cookie";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root, "next/headers": cookieModule } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "neighbor-test-cookie", resolveId(id) { if (id === cookieModule) return id; },
    load(id) { if (id === cookieModule) return "export async function cookies() { return { get() { return { value: globalThis.__neighborTestToken }; } }; }"; } }],
});
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { commandDevPresence } = await vite.ssrLoadModule("/lib/dev/activity-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/neighbor-model.ts");
const { GET } = await vite.ssrLoadModule("/app/api/v1/economy/neighbor/route.ts");
const { POST } = await vite.ssrLoadModule("/app/api/v1/economy/neighbor/commands/route.ts");
const { GET: adminGET, POST: adminPOST } = await vite.ssrLoadModule("/app/api/v1/admin/[...path]/route.ts");
let presenceId;
beforeEach(() => { identities.resetDevStoreForTests(); process.env.NODE_ENV = "test"; delete globalThis.__neighborTestToken; presenceId = undefined; });
after(async () => {
  delete globalThis.__neighborTestToken;
  if (initialMode == null) delete process.env.NODE_ENV; else process.env.NODE_ENV = initialMode;
  await vite.close();
});
const get = (query = "") => new Request(`http://localhost:3000/api/v1/economy/neighbor${query}`);
const post = (body, headers = {}) => new Request("http://localhost:3000/api/v1/economy/neighbor/commands", { method: "POST",
  headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", ...(presenceId ? { "X-Game-Presence": presenceId } : {}), ...headers },
  body: JSON.stringify(body) });
function player() {
  const owner = identities.createDevIdentity("Сосед", crypto.randomUUID()); globalThis.__neighborTestToken = owner.token;
  economy.getDevEconomy(owner.token);
  const saved = globalThis.__zhivDevEconomyStore.profiles.get(owner.me.user.publicId);
  Object.assign(saved.state.buildings, { home: 2, bridge: 1, warehouse: 6 });
  saved.state.completedExplorations = 1; saved.state.wallet.coins = 100000;
  saved.state.inventory = { wood: 20, fiber: 20, stone: 20 };
  return owner;
}
function enter(owner) {
  presenceId = crypto.randomUUID(); commandDevPresence(owner.me.user.publicId, { kind: "resume", presenceId, sequence: 0, active: true }, Date.now(), owner.token);
}
function command(owner, offer) {
  return { requestId: crypto.randomUUID(), ownerPublicId: owner.me.user.publicId, expectedRevision: economy.getDevEconomy(owner.token).revision,
    action: "buy_offer", targetId: offer.id, quantity: offer.quantity, totalPrice: offer.totalPrice };
}

test("neighbor routes require account cookies, reject unknown query fields and never cache private stock", async () => {
  assert.equal((await GET(get())).status, 401);
  const owner = player(), response = await GET(get());
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json(); assert.equal(body.ownerPublicId, owner.me.user.publicId);
  assert.equal(model.neighborViewSchema.safeParse(body).success, true);
  assert.equal((await GET(get("?ownerPublicId=someone"))).status, 400);
});

test("neighbor commands require active gameplay, trusted origin and a bounded valid payload", async () => {
  const owner = player(), offer = (await (await GET(get())).json()).shop.offers[0], request = command(owner, offer);
  assert.equal((await POST(post(request))).status, 409);
  enter(owner);
  assert.equal((await POST(post(request, { Origin: "https://untrusted.example" }))).status, 403);
  assert.equal((await POST(post({ ...request, action: "grant_currency" }))).status, 400);
  assert.equal((await POST(post(request, { "Content-Length": "4096" }))).status, 413);
  const response = await POST(post(request)); assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(model.neighborResultSchema.safeParse(await response.json()).success, true);
  assert.equal((await (await POST(post(request))).json()).replayed, true);
});

test("production web never exposes a memory economy or simulates administrative authorization", async () => {
  const owner = player(); enter(owner);
  const offer = economy.getDevEconomyNeighbor(owner.token).shop.offers[0], request = command(owner, offer);
  process.env.NODE_ENV = "production";
  assert.equal((await GET(get())).status, 503);
  assert.equal((await POST(post(request))).status, 503);
  assert.equal((await adminGET()).status, 503);
  assert.equal((await adminPOST()).status, 503);
});

test("NPC sale schema reads historical player sales and rejects a character impersonating a real account", () => {
  const base = { id: crypto.randomUUID(), sellerPublicId: "TEST-TEST-TEST", sellerName: "Продавец", itemId: "wood", quantity: 1,
    totalPrice: 30, status: "sold", createdAt: new Date().toISOString(), closedAt: new Date().toISOString(), owned: true, feeBps: 500,
    sale: { buyerPublicId: "OLD-PLAYER", buyerName: "Покупатель", buyerAvatarUrl: null, proceedsCoins: 28, claimedAt: null } };
  // Importing the schema through the result keeps the exact production contract under test.
  const sale = model.neighborResultSchema.shape.listing.unwrap().unwrap();
  assert.equal(sale.safeParse(base).success, true);
  assert.equal(sale.safeParse({ ...base, sale: { ...base.sale, buyerKind: "world_character", buyerCharacterId: "berest" } }).success, false);
  assert.equal(sale.safeParse({ ...base, sale: { ...base.sale, buyerKind: "world_character", buyerCharacterId: "berest", buyerPublicId: null } }).success, true);
});

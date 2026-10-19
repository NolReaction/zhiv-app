import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { guestWorldSchema } = await vite.ssrLoadModule("/features/people/guest-world-model.ts");
const { getGuestWorld } = await vite.ssrLoadModule("/features/people/guest-world-api.ts");
const originalFetch = globalThis.fetch;
after(() => vite.close());
afterEach(() => { globalThis.fetch = originalFetch; });
const owner = "0123-4567-89AB", friend = "CDEF-GHJK-MNPQ";
const target = { circleId: crypto.randomUUID(), targetPublicId: friend, displayName: "Друг" };
function snapshot() {
  return { ownerPublicId: owner, circleId: target.circleId, user: { publicId: friend, displayName: "Друг" }, serverTime: "2026-10-18T23:00:00Z",
    world: { buildings: { home: 4, woodlot: 2, bridge: 1 }, equipment: { palette: "moss", head: "rain_hood", neck: "amber_scarf", rod: null }, gifts: [], hiddenGifts: [],
      jobs: [{ id: crypto.randomUUID(), kind: "construction", targetId: "workshop", targetLevel: 3, recipeId: null, startedAt: "2026-10-18T22:00:00Z", finishesAt: "2026-10-19T00:00:00Z", actorId: null, collection: null }] },
    market: { available: true, reason: null, listings: [{ id: crypto.randomUUID(), sellerPublicId: friend, sellerName: "Друг", itemId: "wood", quantity: 2, totalPrice: 20, status: "active", owned: false, feeBps: 500, createdAt: "2026-10-18T22:00:00Z", closedAt: null }] } };
}

test("a visit accepts real appearance, building levels, work clocks and the owner's active listings", () => {
  const value = snapshot();
  assert.deepEqual(guestWorldSchema.parse(value), value);
});

test("private state and unbound listings are rejected at the guest boundary", () => {
  const mutations = [
    value => { value.world.wallet = { coins: 200 }; },
    value => { value.world.inventory = { wood: 100 }; },
    value => { value.world.jobs[0].rewards = { ancient_core: 1 }; },
    value => { value.world.equipment.seed = "private"; },
    value => { value.market.listings[0].sellerPublicId = owner; },
    value => { value.market.listings[0].owned = true; },
    value => { value.market.listings[0].sale = { buyerPublicId: owner, buyerName: "Чужой покупатель", buyerAvatarUrl: null, proceedsCoins: 10, claimedAt: null }; },
    value => { value.market.listings[0].status = "sold"; },
    value => { value.market.listings.push(value.market.listings[0]); },
    value => { value.market.reason = "buyer_locked"; },
    value => { value.user.publicId = owner; },
  ];
  for (const mutate of mutations) {
    const value = snapshot(); mutate(value);
    assert.equal(guestWorldSchema.safeParse(value).success, false, mutate.toString());
  }
});

test("request uses the friendship route with no account override or browser cache", async () => {
  const value = snapshot(); let called;
  globalThis.fetch = async (url, options) => { called = { url, options }; return Response.json(value); };
  assert.deepEqual(await getGuestWorld(owner, target), value);
  assert.equal(called.url, `/api/v1/people/${target.circleId}/world`);
  assert.equal(called.options.cache, "no-store");
  assert.equal(called.options.credentials, "same-origin");
  assert.equal(called.options.method, undefined);
});

test("a response is bound to visitor, friendship and exact host, including after navigation", async () => {
  for (const patch of [{ ownerPublicId: "RSTV-WXYZ-0123" }, { circleId: crypto.randomUUID() }, { user: { publicId: "RSTV-WXYZ-0123", displayName: "Другой" }, market: { available: false, reason: "seller_locked", listings: [] } }]) {
    globalThis.fetch = async () => Response.json({ ...snapshot(), ...patch });
    await assert.rejects(getGuestWorld(owner, target), { status: 409 });
  }
});

test("revoked access, lost session and unsafe server projections never fall back to invented scenery", async () => {
  for (const status of [401, 404, 503]) {
    globalThis.fetch = async () => Response.json({ code: "UNAVAILABLE" }, { status });
    await assert.rejects(getGuestWorld(owner, target), { status });
  }
  globalThis.fetch = async () => Response.json({ ...snapshot(), inventory: { wood: 100 } });
  await assert.rejects(getGuestWorld(owner, target), { status: 502 });
});

test("closing a visit discards a transport that completes after abort", async () => {
  const controller = new AbortController(); let finish;
  globalThis.fetch = () => new Promise(resolve => { finish = () => resolve(Response.json(snapshot())); });
  const request = getGuestWorld(owner, target, controller.signal);
  controller.abort(); finish();
  await assert.rejects(request, { name: "AbortError" });
});

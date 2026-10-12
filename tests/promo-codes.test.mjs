import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { parsePromoCatalog, promoCatalog } = await vite.ssrLoadModule("/lib/server/promo-catalog.ts");
const { promoResultSchema, promoRequestSchema } = await vite.ssrLoadModule("/features/promo/model.ts");
after(() => vite.close());
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
const now = Date.parse("2026-10-12T08:00:00Z");
const entry = { id: "test-gift-v1", code: "TEST-GIFT", enabled: true, title: "Подарок", startsAt: null, endsAt: null, reward: { coins: 500, pearls: 20, items: { wood: 5, stone: 5 } } };
const catalog = (code = entry) => parsePromoCatalog({ version: 1, codes: [code] });
const player = () => identities.createDevIdentity("Промокод", crypto.randomUUID());
const snapshot = p => economy.getDevEconomy(p.token, now);
const command = (p, code = " test-gift ") => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, expectedRevision: snapshot(p).revision, code });
const redeem = (p, request, codes = catalog(), time = now) => economy.redeemDevPromo(p.token, request, codes, time);

test("packaged example is disabled and both catalog and request reject unsafe definitions", () => {
  assert.equal(promoCatalog.codes.find(code => code.id === "welcome-example-v1")?.enabled, false);
  for (const override of [{ reward: { coins: -1 } }, { reward: { pearls: 1.5 } }, { reward: { items: { unknown: 1 } } },
    { reward: { items: { wood: 0 } } }, { reward: {} }, { reward: { coins: 1_000_001 } }, { code: "lowercase" },
    { startsAt: "bad" }, { startsAt: "2026-10-12T09:00:00Z", endsAt: "2026-10-12T08:00:00Z" }]) {
    assert.throws(() => catalog({ ...entry, ...override }));
  }
  assert.throws(() => parsePromoCatalog({ version: 1, codes: [entry, entry] }));
  assert.equal(promoRequestSchema.safeParse({ requestId: crypto.randomUUID(), ownerPublicId: "owner", expectedRevision: 0, code: "TEST", reward: { coins: 999 } }).success, false);
});
test("redemption normalizes code and credits exact visible currencies once with immutable receipt", () => {
  const p = player(), before = snapshot(p), request = command(p), first = redeem(p, request);
  assert.equal(promoResultSchema.safeParse(first).success, true);
  assert.equal(first.state.wallet.coins, before.wallet.coins + 500);
  assert.equal(first.state.wallet.pearls, before.wallet.pearls + 40);
  assert.equal(first.state.inventory.wood, before.inventory.wood + 5);
  assert.equal(first.state.revision, before.revision + 1);
  const replay = redeem(p, { ...request, code: "TEST-GIFT" }, { version: 1, codes: [] });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.reward, first.reward); assert.deepEqual(replay.state.wallet, first.state.wallet);
  assert.throws(() => redeem(p, command(p)), { code: "PROMO_ALREADY_USED" });
});
test("unknown disabled future and expired codes never mutate state", () => {
  for (const [code, override] of [["PROMO_NOT_FOUND", { enabled: false }], ["PROMO_NOT_STARTED", { startsAt: "2026-10-13T00:00:00Z" }], ["PROMO_EXPIRED", { endsAt: "2026-10-12T08:00:00Z" }]]) {
    const p = player(), before = snapshot(p);
    assert.throws(() => redeem(p, command(p), catalog({ ...entry, ...override })), { code });
    assert.deepEqual(snapshot(p), before);
  }
});
test("warehouse full and wallet overflow leave code available for a later successful claim", () => {
  const p = player(); snapshot(p);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  row.state.inventory = { wood: 300 };
  const request = command(p), before = snapshot(p);
  assert.throws(() => redeem(p, request), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(snapshot(p), before);
  row.state.inventory = { wood: 1 }; row.state.wallet.coins = 10_000_000_000;
  assert.throws(() => redeem(p, request), { code: "ECONOMY_CAPACITY" });
  row.state.wallet.coins = 0;
  assert.equal(redeem(p, request).state.wallet.coins, 500);
});
test("stale revision wrong owner and reused action UUID cannot grant resources", () => {
  const p = player(), request = command(p), before = snapshot(p);
  assert.throws(() => redeem(p, { ...request, expectedRevision: before.revision + 1 }), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.throws(() => redeem(p, { ...request, ownerPublicId: "other" }), { code: "ECONOMY_OWNER_CHANGED" });
  const gift = redeem(p, request);
  assert.throws(() => redeem(p, { ...request, code: "OTHER-CODE" }), { code: "ECONOMY_REQUEST_CONFLICT" });
  assert.throws(() => economy.commandDevEconomy(p.token, { requestId: request.requestId, ownerPublicId: request.ownerPublicId, expectedRevision: gift.state.revision, action: "sell", targetId: "wood", quantity: 1, totalPrice: 0 }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
});
test("campaign stable ID survives code rename and gameplay profile removal", () => {
  const p = player(); redeem(p, command(p));
  const renamed = catalog({ ...entry, code: "NEW-NAME" });
  assert.throws(() => redeem(p, command(p, "NEW-NAME"), renamed), { code: "PROMO_ALREADY_USED" });
  globalThis.__zhivDevEconomyStore.profiles.delete(p.me.user.publicId);
  assert.throws(() => redeem(p, command(p), catalog()), { code: "PROMO_ALREADY_USED" });
});
test("separate accounts get independent claims and many same-UUID retries share one credit", async () => {
  const p = player(), q = player(), request = command(p), before = snapshot(p);
  const results = await Promise.all(Array.from({ length: 6 }, () => Promise.resolve().then(() => redeem(p, request))));
  assert.equal(results.filter(result => !result.replayed).length, 1);
  assert.equal(snapshot(p).wallet.coins, before.wallet.coins + 500);
  assert.equal(redeem(q, command(q)).replayed, false);
});
test("client code contains no import or listing of the server promo catalog", async () => {
  for (const file of ["features/promo/api.ts", "features/promo/model.ts", "features/promo/promo-code-form.tsx", "features/economy/ui/market/currency-shop-panel.tsx"]) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /promo-codes\.json|lib\/server\/promo-catalog|WELCOME-EXAMPLE/);
  }
});

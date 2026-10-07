import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const world = await vite.ssrLoadModule("/lib/dev/world-store.ts");
const { economyResultSchema, economyCommandSchema } = await vite.ssrLoadModule("/features/economy/model.ts");
const { wardrobeItems, wardrobePurchaseTarget } = await vite.ssrLoadModule("/features/world/wardrobe.ts");
const { economyDevCommandSchema } = await vite.ssrLoadModule("/features/economy/dev-model.ts");
const now = Date.parse("2026-10-05T20:00:00Z"), originalMode = process.env.NODE_ENV;
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); world.resetDevWorldStoreForTests(); });
after(async () => { if (originalMode == null) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalMode; await vite.close(); });
function player() {
  const p = identities.createDevIdentity("Портной", crypto.randomUUID());
  economy.getDevEconomy(p.token, now);
  globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state.wallet = { coins: 20_000, pearls: 2_000 };
  return p;
}
function command(p, itemId, patch = {}) {
  const item = wardrobeItems.find(item => item.id === itemId);
  return { requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
    expectedRevision: economy.getDevEconomy(p.token, now).revision,
    action: "buy_wardrobe_item", targetId: wardrobePurchaseTarget(item), quantity: 1, totalPrice: item.purchase.amount, ...patch };
}
const issue = (p, cmd) => economy.commandDevEconomy(p.token, cmd, now);

test("coin and pearl clothes debit only their own wallet and become permanent equipable ownership", () => {
  const p = player(), initial = economy.getDevEconomy(p.token, now), beforeWorld = world.getDevWorld(p.token, now);
  const coin = command(p, "fern"), bought = issue(p, coin);
  assert.equal(economyResultSchema.safeParse(bought).success, true);
  assert.equal(bought.state.wallet.coins, initial.wallet.coins - 1200);
  assert.equal(bought.state.wallet.pearls, initial.wallet.pearls);
  assert.deepEqual(bought.state.inventory, initial.inventory);
  assert.deepEqual(bought.state.storage, initial.storage);
  assert.ok(bought.state.wardrobe.includes("fern"));
  assert.throws(() => world.commandDevWorld(p.token, { requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
    expectedRevision: beforeWorld.revision, action: "equip", target: "fern" }, now), { code: "WORLD_REVISION_CONFLICT" });
  const refreshed = world.getDevWorld(p.token, now);
  const equipped = world.commandDevWorld(p.token, { requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
    expectedRevision: refreshed.revision, action: "equip", target: "fern" }, now);
  assert.equal(equipped.snapshot.state.equipment.palette, "fern");
  const premium = issue(p, command(p, "heather"));
  assert.equal(premium.state.wallet.pearls, initial.wallet.pearls - 150);
  assert.equal(premium.state.wallet.coins, bought.state.wallet.coins);
  assert.ok(world.getDevWorld(p.token, now).state.inventory.includes("heather"));
  assert.ok(economy.getDevEconomy(p.token, now).wardrobe.includes("heather"));
});

test("receipt retries never spend twice; a new purchase of the same garment is rejected", () => {
  const p = player(), cmd = command(p, "moon_crown"), accepted = issue(p, cmd);
  const replay = issue(p, { ...cmd, requestId: cmd.requestId.toUpperCase() });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state.wallet, accepted.state.wallet);
  assert.equal(replay.state.revision, accepted.state.revision);
  assert.throws(() => issue(p, { ...cmd, totalPrice: 0 }), { code: "ECONOMY_REQUEST_CONFLICT" });
  assert.throws(() => issue(p, command(p, "moon_crown")), { code: "ECONOMY_WARDROBE_OWNED" });
  assert.equal(economy.getDevEconomy(p.token, now).wardrobe.filter(id => id === "moon_crown").length, 1);
});

test("old clothes cannot be repurchased and unknown, free, reward and fishing items cannot bypass the catalog", () => {
  const p = player();
  world.getDevWorld(p.token, now);
  globalThis.__zhivDevWorldStore.get(p.me.user.publicId).state.inventory.push("fern", "explorer_cap", "willow_rod");
  assert.throws(() => issue(p, command(p, "fern")), { code: "ECONOMY_WARDROBE_OWNED" });
  const before = economy.getDevEconomy(p.token, now);
  assert.ok(before.wardrobe.includes("explorer_cap")); assert.ok(!before.wardrobe.includes("willow_rod"));
  for (const targetId of ["coins:moss", "coins:explorer_cap", "coins:willow_rod", "coins:fish", "coins:__proto__", "pearls:fern", "fern"])
    assert.throws(() => issue(p, command(p, "heather", { targetId })), { code: "ECONOMY_WARDROBE_ITEM" });
  assert.deepEqual(economy.getDevEconomy(p.token, now), before);
});

test("price, quantity, funds, owner and racing revisions fail before any debit or ownership grant", () => {
  const p = player(), stranger = player(), cmd = command(p, "heather"), before = economy.getDevEconomy(p.token, now);
  for (const totalPrice of [0, 149, 151, 2000])
    assert.throws(() => issue(p, { ...cmd, totalPrice }), { code: "ECONOMY_WARDROBE_PRICE_CHANGED" });
  assert.throws(() => issue(p, { ...cmd, quantity: 2 }), { code: "INVALID_ECONOMY_COMMAND" });
  assert.throws(() => issue(stranger, cmd), { code: "ECONOMY_OWNER_CHANGED" });
  assert.deepEqual(economy.getDevEconomy(p.token, now), before);
  const other = command(p, "fern"), paid = issue(p, cmd);
  assert.throws(() => issue(p, other), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.deepEqual(economy.getDevEconomy(p.token, now).wallet, paid.state.wallet);
  globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state.wallet.pearls = 0;
  const poor = economy.getDevEconomy(p.token, now);
  assert.throws(() => issue(p, command(p, "moon_crown")), { code: "ECONOMY_RESOURCES" });
  assert.deepEqual(economy.getDevEconomy(p.token, now), poor);
});

test("clothes cannot be sold or listed and full storage does not prevent a cosmetic purchase", () => {
  const p = player();
  globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state.inventory.wood = 1000;
  const bought = issue(p, command(p, "fern"));
  assert.equal(bought.state.storage.overflow, 800); assert.equal(bought.state.inventory.fern, undefined);
  assert.throws(() => issue(p, command(p, "heather", { action: "sell", targetId: "fern", totalPrice: 0 })), { code: "ECONOMY_ITEM" });
  assert.ok(economy.getDevEconomy(p.token, now).wardrobe.includes("fern"));
});

test("DEV clothing grants are deduplicated, do not charge or discover fish, and never enter normal commands", () => {
  process.env.NODE_ENV = "development";
  const p = player(), cmd = command(p, "fern", { action: "grant_wardrobe", targetId: "all", totalPrice: 0 });
  assert.equal(economyDevCommandSchema.safeParse(cmd).success, true);
  assert.equal(economyCommandSchema.safeParse(cmd).success, false);
  assert.throws(() => issue(p, cmd), { code: "INVALID_ECONOMY_COMMAND" });
  const before = economy.getDevEconomy(p.token, now);
  const result = economy.commandDevEconomyCheat(p.token, cmd, now);
  assert.equal(result.state.wardrobe.length, wardrobeItems.length);
  assert.deepEqual(result.state.wallet, before.wallet); assert.deepEqual(result.state.inventory, before.inventory);
  assert.deepEqual(result.state.fishing, before.fishing);
  assert.equal(economy.commandDevEconomyCheat(p.token, cmd, now).replayed, true);
  assert.ok(world.getDevWorld(p.token, now).state.inventory.includes("moon_crown"));
  process.env.NODE_ENV = "production";
  assert.throws(() => economy.commandDevEconomyCheat(p.token, cmd, now), { code: "DEV_TOOLS_DISABLED" });
});

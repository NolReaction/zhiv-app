import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { currencyExchangeCatalog, currencyExchangeCatalogSchema } = await vite.ssrLoadModule("/features/economy/domain/currency-exchange.ts");
const { newEconomyState, applyEconomyCommand } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { ECONOMY_MAX_BALANCE, formatPearls } = await vite.ssrLoadModule("/features/economy/domain/money.ts");
const { storefrontCatalog } = await vite.ssrLoadModule("/features/economy/domain/storefront.ts");
const { goldExchangeReason } = await vite.ssrLoadModule("/features/economy/ui/market/currency-gold-exchange.tsx");
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts"), api = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const now = Date.parse("2026-11-02T12:00:00Z"), offers = currencyExchangeCatalog.offers;
const fresh = () => { const s = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 }); s.wallet = { coins: 100, pearls: 200 }; return s; };
const command = (offer = offers[0], extra = {}) => ({ action: "exchange_pearls_for_gold", targetId: offer.id, quantity: 1, totalPrice: offer.pearls,
  ownerPublicId: "0123-4567-89AB", expectedRevision: 0, requestId: crypto.randomUUID(), ...extra });
function apply(s, c = command()) { return applyEconomyCommand(s, c, now, () => crypto.randomUUID()); }
function fails(s, code, extra = {}) { const before = structuredClone(s); assert.throws(() => apply(s, command(offers[0], extra)), { code }); assert.deepEqual(s, before); }
beforeEach(() => identities.resetDevStoreForTests());

test("exchange packages show whole pearls, bounded volume bonuses and no better split at the same budget", () => {
  assert.deepEqual(offers.map(o => [formatPearls(o.pearls), o.coins, o.bonusPercent]), [["20", 1000, 0], ["50", 2750, 10], ["100", 6000, 20]]);
  assert.equal(storefrontCatalog.paymentsEnabled, false);
  for (const pack of offers) {
    assert.equal(pack.coins, pack.pearls * 25 * (1 + pack.bonusPercent / 100));
    const smaller = offers.filter(o => o.pearls < pack.pearls), best = Array(pack.pearls + 1).fill(0);
    for (let budget = 1; budget <= pack.pearls; budget++) best[budget] = Math.max(best[budget - 1], ...smaller.filter(o => o.pearls <= budget).map(o => best[budget - o.pearls] + o.coins));
    assert.ok(best.at(-1) <= pack.coins, "splitting cannot beat the larger package");
  }
  for (const patch of [{ pearls: 41 }, { coins: 999 }, { bonusPercent: 21 }]) {
    const bad = structuredClone(currencyExchangeCatalog); Object.assign(bad.offers[0], patch);
    assert.equal(currencyExchangeCatalogSchema.safeParse(bad).success, false);
  }
});

test("all packages use authoritative exact raw charges independently of house and do not grant items or progress", () => {
  for (const home of [1, 5]) for (const offer of offers) {
    const s = fresh(); s.buildings.home = home; const inventory = structuredClone(s.inventory), progression = structuredClone(s.progression);
    apply(s, command(offer)); assert.deepEqual(s.wallet, { coins: 100 + offer.coins, pearls: 200 - offer.pearls });
    assert.deepEqual(s.inventory, inventory); assert.deepEqual(s.progression, progression);
  }
});

test("wrong price, old offer, insufficient pearls and overflow leave the wallet intact", () => {
  fails(fresh(), "ECONOMY_EXCHANGE_CHANGED", { targetId: "gold_pouch_v0" });
  for (const totalPrice of [0, 20, 39, 41, 200]) fails(fresh(), "ECONOMY_EXCHANGE_PRICE_CHANGED", { totalPrice });
  const poor = fresh(); poor.wallet.pearls = 39; fails(poor, "ECONOMY_PEARLS");
  const full = fresh(); full.wallet.coins = ECONOMY_MAX_BALANCE - 999; fails(full, "ECONOMY_CAPACITY");
  full.wallet.coins--; apply(full); assert.equal(full.wallet.coins, ECONOMY_MAX_BALANCE);
  for (const extra of [{ quantity: 2 }, { quantity: 0 }, { fishSelection: {} }, { itemId: "wood" }, { voyageId: crypto.randomUUID() }])
    fails(fresh(), "INVALID_ECONOMY_COMMAND", extra);
});

test("receipt replay, stale revision and account ownership prevent double spending and duplicate gold", () => {
  const player = identities.createDevIdentity("Обмен", crypto.randomUUID()); api.getDevEconomy(player.token, now);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(player.me.user.publicId); row.state = fresh();
  const before = api.getDevEconomy(player.token, now);
  const input = command(offers[2], { ownerPublicId: player.me.user.publicId, expectedRevision: before.revision });
  const first = api.commandDevEconomy(player.token, input, now), replay = api.commandDevEconomy(player.token, input, now + 1000);
  assert.equal(replay.replayed, true); assert.equal(first.acceptedRevision, replay.acceptedRevision);
  assert.deepEqual(first.state.wallet, { coins: 6100, pearls: 0 }); assert.deepEqual(replay.state.wallet, first.state.wallet);
  assert.throws(() => api.commandDevEconomy(player.token, { ...input, requestId: crypto.randomUUID() }, now), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.throws(() => api.commandDevEconomy(player.token, { ...input, totalPrice: 0 }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
  assert.throws(() => api.commandDevEconomy(player.token, { ...input, requestId: crypto.randomUUID(), ownerPublicId: "0123-4567-89AB" }, now), { code: "ECONOMY_OWNER_CHANGED" });
  assert.deepEqual(api.getDevEconomy(player.token, now).wallet, first.state.wallet);
});

test("confirmation expires after wallet revision or owner changes and cannot bypass offline or uncertain guards", () => {
  const offer = offers[0], quote = { owner: "owner", revision: 1, id: offer.id, pearls: offer.pearls, coins: offer.coins };
  const economy = { snapshot: { ...fresh(), ownerPublicId: "owner", revision: 1 }, snapshotConfirmed: true,
    busy: false, uncertain: false, directActionsAvailable: true, retryAt: 0, now };
  assert.equal(goldExchangeReason(economy, quote), null);
  for (const patch of [{ busy: true }, { uncertain: true }, { directActionsAvailable: false }, { snapshotConfirmed: false }, { pendingProductionCount: 1 }])
    assert.ok(goldExchangeReason({ ...economy, ...patch }, quote));
  for (const patch of [{ revision: 2 }, { ownerPublicId: "other" }, { wallet: { coins: 0, pearls: 39 } }, { wallet: { coins: ECONOMY_MAX_BALANCE, pearls: 200 } }])
    assert.ok(goldExchangeReason({ ...economy, snapshot: { ...economy.snapshot, ...patch } }, quote));
  assert.ok(goldExchangeReason(economy, { ...quote, coins: 1001 }));
});

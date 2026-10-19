import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), originalMode = process.env.NODE_ENV;
const cookieModule = "\0dev-bots-test-cookie";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root, "next/headers": cookieModule } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "dev-bots-test-cookie", resolveId(id) { if (id === cookieModule) return id; },
    load(id) { if (id === cookieModule) return "export async function cookies(){ return {get(){return {value:globalThis.__devBotsTestToken}}} }"; } }],
});
const social = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const bots = await vite.ssrLoadModule("/lib/dev/bot-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/world/dev/dev-bot-model.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { marketMinimumPrice, marketSaleFee } = await vite.ssrLoadModule("/features/economy/domain/market-rules.ts");
const { commandDevPresence } = await vite.ssrLoadModule("/lib/dev/activity-store.ts");
const { GET, POST } = await vite.ssrLoadModule("/app/api/v1/dev/bots/route.ts");
const key = () => crypto.randomUUID(), now = Date.now(), presence = new Map();
const ok = result => { assert.equal(result.kind, "ok"); return result.value; };
const read = player => bots.getDevBots(player.token, now);
const command = (player, action) => ({ ownerPublicId: player.me.user.publicId, requestId: key(), ...action });
const act = (player, action, at = now) => bots.commandDevBots(player.token, command(player, action), at);
const create = (player, homeLevel = 2) => { const result = act(player, { action: "create", displayName: "Тестовый сосед", homeLevel }); return result.snapshot.bots.find(bot => bot.id === result.botId); };
function player() {
  const player = social.createDevIdentity("Разработчик", key()); globalThis.__devBotsTestToken = player.token;
  const id = key(); commandDevPresence(player.me.user.publicId, { kind: "resume", presenceId: id, sequence: 0, active: true }, Date.now(), player.token);
  presence.set(player.token, id); return player;
}
function post(body, headers = {}) {
  return new Request("http://localhost:3000/api/v1/dev/bots", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000",
    ...(presence.has(globalThis.__devBotsTestToken) ? { "X-Game-Presence": presence.get(globalThis.__devBotsTestToken) } : {}), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
function ownCheat(player, action, targetId, quantity = 1) {
  const state = economy.getDevEconomy(player.token, now);
  return economy.commandDevEconomyCheat(player.token, { requestId: key(), ownerPublicId: player.me.user.publicId, expectedRevision: state.revision, action, targetId, quantity, totalPrice: 0 }, now);
}
const identityState = () => structuredClone(globalThis.__zhivDevStore);
beforeEach(() => { social.resetDevStoreForTests(); delete globalThis.__zhivDevBotReceipts; process.env.NODE_ENV = "development"; delete globalThis.__devBotsTestToken; presence.clear(); });
after(async () => { if (originalMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalMode; delete globalThis.__devBotsTestToken; await vite.close(); });

test("creation makes a genuine accepted friend and current guest world without exposing a bot session", async () => {
  const owner = player(), cmd = command(owner, { action: "create", displayName: "Сосед у маяка", homeLevel: 3 });
  const response = await POST(post(cmd)), result = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(model.devBotResultSchema.safeParse(result).success, true);
  const bot = result.snapshot.bots[0], people = ok(social.listDevPeople(owner.token));
  assert.equal(bot.id, result.botId); assert.equal(bot.economy.buildings.home, 3);
  assert.equal(people.people.length, 1); assert.equal(people.people[0].user.publicId, bot.publicId); assert.equal(people.people[0].circleId, bot.circleId);
  assert.equal(people.incomingRequests.length, 0); assert.equal(people.outgoingRequests.length, 0);
  const visit = ok(social.getDevGuestWorld(owner.token, bot.circleId, now));
  assert.equal(visit.user.publicId, bot.publicId); assert.deepEqual(visit.world.buildings, bot.economy.buildings);
  for (const secret of ["token", "ownerUserId", "authSession", "expiresAt", "bootstrapKey"]) assert.equal(JSON.stringify(result).includes(secret), false, secret);
  assert.equal(social.getDevOwnedBots(owner.token).every(privateBot => !JSON.stringify(result).includes(privateBot.token)), true);
});

test("lost creation and grant acknowledgements replay once and return current snapshots", () => {
  const owner = player(), cmd = command(owner, { action: "create", displayName: "Бот", homeLevel: 2 });
  const first = bots.commandDevBots(owner.token, cmd, now), bot = first.snapshot.bots[0];
  const grant = command(owner, { action: "grant_currency", botId: bot.id, currency: "coins", quantity: 1000 });
  const credited = bots.commandDevBots(owner.token, grant, now);
  const replay = bots.commandDevBots(owner.token, grant, now);
  assert.equal(replay.replayed, true); assert.equal(replay.snapshot.bots[0].economy.wallet.coins, credited.snapshot.bots[0].economy.wallet.coins);
  assert.equal(bots.commandDevBots(owner.token, cmd, now).snapshot.bots[0].economy.wallet.coins, credited.snapshot.bots[0].economy.wallet.coins);
  assert.equal(read(owner).bots.length, 1);
  assert.equal(bots.commandDevBots(owner.token, { ...grant, requestId: grant.requestId.toUpperCase(), botId: bot.id.toUpperCase() }, now).replayed, true);
  assert.throws(() => bots.commandDevBots(owner.token, { ...grant, quantity: 2000 }, now), { code: "DEV_BOT_REQUEST_CONFLICT" });
  act(owner, { action: "delete", botId: bot.id });
  assert.deepEqual(bots.commandDevBots(owner.token, cmd, now).snapshot.bots, [], "an old create receipt cannot resurrect a deleted bot");
});

test("bot management is bound to the authenticated owner and cannot target a real account or another owner's bot", () => {
  const first = player(), second = player(), bot = create(first), otherBot = create(second), before = read(first), identities = identityState();
  for (const action of [{ action: "delete", botId: bot.id }, { action: "grant_item", botId: bot.id, itemId: "wood", quantity: 1 }, { action: "rename", botId: bot.id, displayName: "Чужой" }])
    assert.throws(() => act(second, action), { code: "DEV_BOT_NOT_FOUND", status: 404 });
  assert.throws(() => act(first, { action: "delete", botId: second.me.user.publicId }), { code: "INVALID_DEV_BOT_COMMAND" });
  assert.throws(() => bots.commandDevBots(second.token, command(first, { action: "delete", botId: otherBot.id }), now), { code: "DEV_BOT_OWNER_CHANGED" });
  assert.throws(() => bots.commandDevBots(undefined, command(first, { action: "delete", botId: bot.id }), now), { code: "UNAUTHORIZED" });
  assert.throws(() => bots.getDevBots(second.token, now, first.me.user.publicId), { code: "DEV_BOT_OWNER_CHANGED" });
  assert.deepEqual(read(first), before); assert.deepEqual(identityState(), identities);
});

test("each owner has five independent bots and deletion frees only their own slot", () => {
  const first = player(), second = player();
  const created = Array.from({ length: 5 }, () => create(first));
  assert.throws(() => create(first), { code: "DEV_BOT_LIMIT" });
  assert.equal(create(second).economy.buildings.home, 2);
  act(first, { action: "delete", botId: created[2].id });
  assert.equal(create(first).economy.buildings.home, 2); assert.equal(read(first).bots.length, 5); assert.equal(read(second).bots.length, 1);
});

test("preset building and clothing changes immediately reach the normal guest world", () => {
  const owner = player(), bot = create(owner, 1);
  act(owner, { action: "set_home", botId: bot.id, homeLevel: 4 });
  act(owner, { action: "set_building", botId: bot.id, buildingId: "home", level: 3 });
  act(owner, { action: "equip", botId: bot.id, slot: "head", itemId: "rain_hood" });
  act(owner, { action: "equip", botId: bot.id, slot: "neck", itemId: "amber_scarf" });
  act(owner, { action: "equip", botId: bot.id, slot: "palette", itemId: "fern" });
  act(owner, { action: "equip", botId: bot.id, slot: "rod", itemId: "willow_rod" });
  let visit = ok(social.getDevGuestWorld(owner.token, bot.circleId, now));
  assert.equal(visit.world.buildings.home, 3); assert.equal(visit.world.equipment.head, "rain_hood"); assert.equal(visit.world.equipment.neck, "amber_scarf");
  assert.equal(visit.world.equipment.palette, "fern"); assert.equal(visit.world.equipment.rod, "willow_rod");
  act(owner, { action: "equip", botId: bot.id, slot: "head", itemId: null });
  act(owner, { action: "rename", botId: bot.id, displayName: "  Новый   сосед  " });
  visit = ok(social.getDevGuestWorld(owner.token, bot.circleId, now));
  assert.equal(visit.world.equipment.head, null); assert.equal(visit.user.displayName, "Новый сосед");
  assert.equal(read(owner).bots[0].displayName, "Новый сосед");
});

test("the normal friend purchase moves actual bot stock and money with fees and does not replay a sold lot", () => {
  const owner = player(), bot = create(owner);
  ownCheat(owner, "apply_settlement", "home", 2); ownCheat(owner, "grant_currency", "coins", 10000);
  act(owner, { action: "grant_item", botId: bot.id, itemId: "wood", quantity: 10 });
  const postCommand = command(owner, { action: "create_listing", botId: bot.id, itemId: "wood", quantity: 2, totalPrice: marketMinimumPrice("wood", 2) });
  const posted = bots.commandDevBots(owner.token, postCommand, now).snapshot.bots[0], listing = posted.listings[0];
  assert.equal(posted.economy.inventory.wood, (bot.economy.inventory.wood ?? 0) + 8); assert.equal(posted.economy.storage.reserved, 2);
  const buyerBefore = economy.getDevEconomy(owner.token, now);
  const bought = economy.commandDevGuestWorldMarket(owner.token, bot.circleId, { requestId: key(), ownerPublicId: owner.me.user.publicId,
    expectedRevision: buyerBefore.revision, action: "buy_listing", targetId: listing.id, quantity: listing.quantity, totalPrice: listing.totalPrice }, now);
  assert.equal(bought.state.inventory.wood, (buyerBefore.inventory.wood ?? 0) + 2);
  assert.equal(bought.state.wallet.coins, buyerBefore.wallet.coins - listing.totalPrice);
  const current = read(owner).bots[0]; assert.equal(current.listings.length, 1);
  assert.equal(current.listings[0].sale.buyerPublicId, owner.me.user.publicId);
  assert.equal(current.economy.wallet.coins, posted.economy.wallet.coins); assert.equal(current.economy.storage.reserved, 0);
  assert.equal(bots.commandDevBots(owner.token, postCommand, now).snapshot.bots[0].listings[0].status, "sold", "replay returns the current pending shelf");
  const claim = command(owner, { action: "claim_sale", botId: bot.id, listingId: listing.id });
  const claimed = bots.commandDevBots(owner.token, claim, now).snapshot.bots[0];
  assert.equal(claimed.economy.wallet.coins, posted.economy.wallet.coins + listing.totalPrice - marketSaleFee(listing.totalPrice, listing.feeBps));
  assert.equal(claimed.listings.length, 0);
  assert.equal(bots.commandDevBots(owner.token, claim, now).snapshot.bots[0].economy.wallet.coins, claimed.economy.wallet.coins);
});

test("posting and cancellation retain market locks prices stock ownership and exactly-once escrow", () => {
  const owner = player(), bot = create(owner, 1), other = create(owner);
  act(owner, { action: "grant_item", botId: bot.id, itemId: "wood", quantity: 4 });
  const offer = { action: "create_listing", botId: bot.id, itemId: "wood", quantity: 2, totalPrice: marketMinimumPrice("wood", 2) };
  assert.throws(() => act(owner, offer), { code: "ECONOMY_MARKET_LOCKED" });
  act(owner, { action: "set_home", botId: bot.id, homeLevel: 2 });
  assert.throws(() => act(owner, { ...offer, totalPrice: 1 }), { code: "ECONOMY_MARKET_PRICE" });
  const posted = act(owner, offer).snapshot.bots.find(item => item.id === bot.id), listing = posted.listings[0];
  assert.throws(() => act(owner, { action: "cancel_listing", botId: other.id, listingId: listing.id }), { code: "ECONOMY_MARKET_OWNER" });
  const cancel = command(owner, { action: "cancel_listing", botId: bot.id, listingId: listing.id });
  bots.commandDevBots(owner.token, cancel, now); bots.commandDevBots(owner.token, cancel, now);
  const restored = read(owner).bots.find(item => item.id === bot.id);
  assert.equal(restored.economy.inventory.wood, (bot.economy.inventory.wood ?? 0) + 4); assert.equal(restored.economy.storage.reserved, 0); assert.equal(restored.listings.length, 0);
});

test("a controlled bot buys only the managing player's active lot through the real friendship and waits for manual payout", () => {
  const owner = player(), bot = create(owner), foreign = player();
  ownCheat(owner, "apply_settlement", "home", 2); ownCheat(owner, "grant_item", "wood", 3);
  const state = economy.getDevEconomy(owner.token, now);
  const listing = economy.commandDevEconomyMarket(owner.token, { requestId: key(), ownerPublicId: owner.me.user.publicId,
    expectedRevision: state.revision, action: "create_listing", targetId: "wood", quantity: 1, totalPrice: 30 }, now).listing;
  assert.equal(read(owner).ownListings[0].id, listing.id);
  const before = economy.getDevEconomy(owner.token, now), botBefore = read(owner).bots[0];
  const cmd = command(owner, { action: "buy_listing", botId: bot.id, listingId: listing.id });
  const result = bots.commandDevBots(owner.token, cmd, now), purchased = result.snapshot.bots[0];
  assert.equal(purchased.economy.inventory.wood, (botBefore.economy.inventory.wood ?? 0) + 1);
  assert.equal(purchased.economy.wallet.coins, botBefore.economy.wallet.coins - 30);
  assert.deepEqual(result.snapshot.ownListings, []);
  assert.equal(economy.getDevEconomy(owner.token, now).wallet.coins, before.wallet.coins);
  const sale = economy.getDevEconomyMarket(owner.token, {}, now).mine[0];
  assert.equal(sale.sale.buyerPublicId, bot.publicId); assert.equal(sale.sale.buyerName, bot.displayName); assert.equal(sale.sale.proceedsCoins, 28);
  assert.equal(bots.commandDevBots(owner.token, cmd, now).snapshot.bots[0].economy.wallet.coins, purchased.economy.wallet.coins);
  assert.throws(() => act(owner, { action: "buy_listing", botId: bot.id, listingId: listing.id }), { code: "DEV_BOT_LISTING_UNAVAILABLE" });
  assert.throws(() => act(foreign, { action: "buy_listing", botId: bot.id, listingId: listing.id }), { code: "DEV_BOT_NOT_FOUND" });
  const current = economy.getDevEconomy(owner.token, now);
  const claim = economy.commandDevEconomyMarket(owner.token, { requestId: key(), ownerPublicId: owner.me.user.publicId,
    expectedRevision: current.revision, action: "claim_sale", targetId: listing.id, quantity: 1, totalPrice: 0 }, now);
  assert.equal(claim.state.wallet.coins, before.wallet.coins + 28);
});

test("bot purchases reject another seller's lot and revoked or private owner worlds without bypassing common market checks", () => {
  const owner = player(), bot = create(owner), other = create(owner);
  ownCheat(owner, "apply_settlement", "home", 2); ownCheat(owner, "grant_item", "wood", 1);
  act(owner, { action: "grant_item", botId: other.id, itemId: "wood", quantity: 1 });
  const foreign = act(owner, { action: "create_listing", botId: other.id, itemId: "wood", quantity: 1, totalPrice: 30 }).snapshot.bots.find(item => item.id === other.id).listings[0];
  assert.throws(() => act(owner, { action: "buy_listing", botId: bot.id, listingId: foreign.id }), { code: "DEV_BOT_LISTING_UNAVAILABLE" });
  const state = economy.getDevEconomy(owner.token, now);
  const listing = economy.commandDevEconomyMarket(owner.token, { requestId: key(), ownerPublicId: owner.me.user.publicId,
    expectedRevision: state.revision, action: "create_listing", targetId: "wood", quantity: 1, totalPrice: 30 }, now).listing;
  const before = read(owner).bots[0].economy;
  ok(social.updateDevSharing(owner.token, bot.circleId, "OFF"));
  assert.throws(() => act(owner, { action: "buy_listing", botId: bot.id, listingId: listing.id }), { code: "GUEST_WORLD_UNAVAILABLE" });
  assert.deepEqual(read(owner).bots[0].economy, before);
});

test("privacy switches use real access checks and deletion removes the bot identity world and lots only", () => {
  const owner = player(), realFriend = player(), bot = create(owner), own = economy.getDevEconomy(owner.token, now);
  const request = ok(social.sendDevDirectRequest(owner.token, realFriend.me.user.publicId, key())); ok(social.actOnDevDirectRequest(realFriend.token, request.request.requestId, "ACCEPTED"));
  act(owner, { action: "grant_item", botId: bot.id, itemId: "wood", quantity: 2 });
  act(owner, { action: "create_listing", botId: bot.id, itemId: "wood", quantity: 1, totalPrice: marketMinimumPrice("wood", 1) });
  act(owner, { action: "set_sharing", botId: bot.id, sharingMode: "OFF" });
  assert.equal(read(owner).bots[0].sharingMode, "OFF"); assert.equal(social.getDevGuestWorld(owner.token, bot.circleId).kind, "not-found");
  act(owner, { action: "set_sharing", botId: bot.id, sharingMode: "LATEST_ONLY" });
  assert.equal(read(owner).bots[0].sharingMode, "LATEST_ONLY"); assert.equal(social.getDevGuestWorld(owner.token, bot.circleId).kind, "ok");
  const saved = globalThis.__zhivDevEconomyStore;
  saved.turnover.set(bot.publicId, { day: "2026-10-19", buysUsed: 30, salesUsed: 60, barterUsed: 0 });
  saved.turnover.set(owner.me.user.publicId, { day: "2026-10-19", buysUsed: 90, salesUsed: 0, barterUsed: 0 });
  saved.promoClaims.set(bot.publicId, new Map()); saved.promoClaims.set(owner.me.user.publicId, new Map());
  const deletion = command(owner, { action: "delete", botId: bot.id }); bots.commandDevBots(owner.token, deletion, now);
  assert.equal(bots.commandDevBots(owner.token, deletion, now).replayed, true);
  assert.equal(social.getDevGuestWorld(owner.token, bot.circleId).kind, "not-found");
  assert.equal(social.lookupDevUser(owner.token, bot.publicId).kind, "not-found");
  assert.equal(globalThis.__zhivDevWorldStore.has(bot.publicId), false); assert.equal(globalThis.__zhivDevEconomyStore.profiles.has(bot.publicId), false);
  assert.equal([...globalThis.__zhivDevEconomyStore.listings.values()].some(item => item.sellerPublicId === bot.publicId), false);
  assert.equal(saved.turnover.has(bot.publicId), false); assert.equal(saved.promoClaims.has(bot.publicId), false);
  assert.equal(saved.turnover.get(owner.me.user.publicId).buysUsed, 90); assert.equal(saved.promoClaims.has(owner.me.user.publicId), true);
  assert.deepEqual(economy.getDevEconomy(owner.token, now), own);
  assert.deepEqual(ok(social.listDevPeople(owner.token)).people.map(item => item.user.publicId), [realFriend.me.user.publicId]);
});

test("bot harvest timers use real growth collection and delivery without silently claiming rewards", () => {
  const owner = player(), bot = create(owner, 1);
  const recipe = economyCatalog.recipes.find(recipe => recipe.id === "grow_berries"); assert.ok(recipe);
  const started = act(owner, { action: "start_job", botId: bot.id, kind: "production", targetId: recipe.id }).snapshot.bots[0];
  assert.equal(started.economy.jobs.length, 1); assert.equal(ok(social.getDevGuestWorld(owner.token, bot.circleId, now)).world.jobs[0].id, started.economy.jobs[0].id);
  assert.throws(() => act(owner, { action: "set_home", botId: bot.id, homeLevel: 2 }), { code: "ECONOMY_BUILDING_BUSY" });
  const later = now + 1000;
  act(owner, { action: "claim_job", botId: bot.id, jobId: started.economy.jobs[0].id }, later);
  const collecting = bots.getDevBots(owner.token, later).bots[0].economy.jobs[0];
  assert.ok(collecting.collection.startedAt);
  act(owner, { action: "claim_job", botId: bot.id, jobId: collecting.id }, Date.parse(collecting.collection.finishesAt));
  assert.equal(read(owner).bots[0].economy.jobs.length, 0); assert.ok(read(owner).bots[0].economy.inventory.berries > 0);
});

test("construction starts through normal prerequisites and only changes the level after acceleration and claiming", () => {
  const owner = player(), bot = create(owner, 2);
  act(owner, { action: "set_building", botId: bot.id, buildingId: "garden", level: 1 });
  const upgrade = economyCatalog.buildings.find(building => building.id === "garden").levels.find(level => level.level === 2);
  act(owner, { action: "grant_currency", botId: bot.id, currency: "coins", quantity: 1000 });
  for (const [itemId, quantity] of Object.entries(upgrade.cost.items)) act(owner, { action: "grant_item", botId: bot.id, itemId, quantity });
  const started = act(owner, { action: "start_job", botId: bot.id, kind: "construction", targetId: "garden" }).snapshot.bots[0];
  const job = started.economy.jobs.find(job => job.kind === "construction"); assert.ok(job);
  assert.equal(started.economy.buildings.garden, 1);
  assert.throws(() => act(owner, { action: "claim_job", botId: bot.id, jobId: job.id }), { code: "ECONOMY_JOB_NOT_READY" });
  const accelerated = act(owner, { action: "finish_jobs", botId: bot.id }).snapshot.bots[0];
  assert.equal(accelerated.economy.buildings.garden, 1); assert.equal(accelerated.economy.jobs[0].finishesAt, new Date(now).toISOString());
  const claimed = act(owner, { action: "claim_job", botId: bot.id, jobId: job.id }).snapshot.bots[0];
  assert.equal(claimed.economy.buildings.garden, 2); assert.equal(claimed.economy.jobs.length, 0);
  assert.equal(ok(social.getDevGuestWorld(owner.token, bot.circleId, now)).world.buildings.garden, 2);
});

test("the DEV endpoint requires auth origin JSON body size and the current session's live presence", async () => {
  assert.equal((await GET(new Request("http://localhost:3000/api/v1/dev/bots"))).status, 401);
  const owner = player(), cmd = command(owner, { action: "create", displayName: "Бот", homeLevel: 2 });
  assert.equal((await POST(post(cmd, { Origin: "https://evil.test" }))).status, 403);
  assert.equal((await POST(post(cmd, { "Sec-Fetch-Site": "cross-site" }))).status, 403);
  assert.equal((await POST(post(cmd, { "Content-Type": "text/plain" }))).status, 415);
  assert.equal((await POST(post(" ".repeat(4097)))).status, 413);
  assert.equal((await POST(post(cmd, { "Content-Length": "4097" }))).status, 413);
  assert.equal((await POST(post(cmd, { "X-Game-Presence": key() }))).status, 409);
  const second = player(); globalThis.__devBotsTestToken = owner.token;
  assert.equal((await POST(post(cmd, { "X-Game-Presence": presence.get(second.token) }))).status, 409);
  assert.equal((await GET(new Request("http://localhost:3000/api/v1/dev/bots?ownerPublicId=wrong"))).status, 400);
  assert.equal(read(owner).bots.length, 0);
});

test("test production preview and missing environments cannot read or mutate bots including directly", async () => {
  const owner = player(), bot = create(owner);
  const cmd = command(owner, { action: "delete", botId: bot.id });
  for (const mode of ["test", "production", "preview", undefined]) {
    if (mode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = mode;
    assert.equal((await GET(new Request("http://localhost:3000/api/v1/dev/bots"))).status, 503);
    assert.equal((await POST(post(cmd))).status, 503);
    assert.throws(() => bots.getDevBots(owner.token), { code: "DEV_API_DISABLED" });
    assert.throws(() => bots.commandDevBots(owner.token, cmd), { code: "DEV_API_DISABLED" });
    assert.equal(social.deleteDevOwnedBot(owner.token, bot.id), null);
  }
  process.env.NODE_ENV = "development"; assert.equal(read(owner).bots.length, 1);
});

test("invalid exact commands cannot modify bot state or reveal private credentials", async () => {
  const owner = player(), bot = create(owner), before = read(owner);
  const base = command(owner, { action: "set_building", botId: bot.id, buildingId: "home", level: 0 });
  const invalid = [base, { ...base, buildingId: "unknown", level: 1 }, { ...base, level: 99 },
    command(owner, { action: "create", displayName: " ", homeLevel: 1 }), command(owner, { action: "create", displayName: "Бот", homeLevel: 6 }),
    command(owner, { action: "equip", botId: bot.id, slot: "palette", itemId: null }), command(owner, { action: "equip", botId: bot.id, slot: "head", itemId: "amber_scarf" }),
    command(owner, { action: "grant_item", botId: bot.id, itemId: "__proto__", quantity: 1 }),
    command(owner, { action: "grant_currency", botId: bot.id, currency: "coins", quantity: -1 }),
    command(owner, { action: "delete", botId: bot.id, token: "private" }), null, [], { action: "erase_save" }];
  for (const input of invalid) {
    assert.equal(model.devBotCommandSchema.safeParse(input).success, false);
    assert.equal((await POST(post(input))).status, 400);
  }
  assert.deepEqual(read(owner), before);
});

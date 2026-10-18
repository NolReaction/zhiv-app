import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// Calls the real local HTTP handlers with Web Requests. This intentionally does
// not claim to exercise Ktor, PostgreSQL, a reverse proxy or internet traffic.
const root = fileURLToPath(new URL("..", import.meta.url));
const cookiesId = "\0security-sandbox-cookies", originalMode = process.env.NODE_ENV;
const context = new AsyncLocalStorage();
let handlerRequests = 0;
globalThis.__securitySandboxContext = context;
const vite = await createServer({ appType: "custom", configFile: false, root,
  cacheDir: `/tmp/zhiv-security-sandbox-${process.pid}`,
  resolve: { alias: { "@": root, "next/headers": cookiesId } },
  server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "security-sandbox-cookies", resolveId(id) { if (id === cookiesId) return id; },
    load(id) { if (id === cookiesId) return `export async function cookies() { return { get() { return { value: globalThis.__securitySandboxContext.getStore()?.token }; } }; }`; } }],
});
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { marketMinimumPrice, marketSaleFee } = await vite.ssrLoadModule("/features/economy/domain/market-rules.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const presence = await vite.ssrLoadModule("/lib/dev/activity-store.ts");
const mail = await vite.ssrLoadModule("/lib/dev/mail-store.ts");
const routes = Object.fromEntries(await Promise.all([
  ["economy", "/app/api/v1/economy/commands/route.ts"],
  ["market", "/app/api/v1/economy/market/commands/route.ts"],
  ["barter", "/app/api/v1/economy/barter/commands/route.ts"],
  ["mail", "/app/api/v1/mail/route.ts"],
  ["readMail", "/app/api/v1/mail/[id]/read/route.ts"],
  ["admin", "/app/api/v1/admin/[...path]/route.ts"],
].map(async ([name, path]) => [name, await vite.ssrLoadModule(path)])));

beforeEach(() => { process.env.NODE_ENV = "test"; identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(async () => {
  delete globalThis.__securitySandboxContext;
  if (originalMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalMode;
  await vite.close();
});
const uuid = () => crypto.randomUUID();
function player() {
  const actor = identities.createDevIdentity("Изолированный security sandbox", uuid());
  actor.presenceId = uuid();
  presence.commandDevPresence(actor.me.user.publicId, { kind: "resume", presenceId: actor.presenceId, sequence: 0, active: true }, Date.now(), actor.token);
  economy.getDevEconomy(actor.token);
  return actor;
}
const profile = actor => globalThis.__zhivDevEconomyStore.profiles.get(actor.me.user.publicId);
const saved = actor => structuredClone(profile(actor));
function command(actor, extra = {}) {
  return { requestId: uuid(), ownerPublicId: actor.me.user.publicId, expectedRevision: profile(actor).revision,
    action: "start_production", targetId: "grow_berries", quantity: 1, totalPrice: 0, ...extra };
}
function request(actor, path, body, headers = {}, method = "POST") {
  handlerRequests++;
  const options = { method, headers: { Origin: "http://localhost:3000", "Content-Type": "application/json",
    ...(actor ? { "X-Game-Presence": actor.presenceId } : {}), ...headers } };
  if (body !== undefined) { options.body = typeof body === "string" || body instanceof ReadableStream ? body : JSON.stringify(body); if (body instanceof ReadableStream) options.duplex = "half"; }
  return new Request(`http://localhost:3000${path}`, options);
}
const post = (actor, name, body, headers) => context.run({ token: actor?.token }, () => routes[name].POST(request(actor,
  `/api/v1/economy${name === "economy" ? "" : `/${name}`}/commands`, body, headers)));
async function rejected(response, statuses = [400, 409]) {
  const body = await response.json();
  assert.ok(statuses.includes(response.status), `${response.status}: ${JSON.stringify(body)}`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(typeof body.code, "string");
  assert.doesNotMatch(JSON.stringify(body), /(?:SELECT |INSERT INTO |stackTrace|node_modules|java\.sql\.)/i);
  return body;
}
async function accepted(response) { assert.equal(response.status, 200, await response.clone().text()); return response.json(); }
const injections = ["' OR '1'='1", "x'; DROP TABLE users;--", "1 UNION SELECT NULL--", "${jndi:ldap://invalid.example/x}",
  "../../admin", "__proto__", "constructor", "prototype", "<svg onload=alert(1)>", "\u0000", "a\u202eb", "grow_berries@fish_common@extra"];

test("sandbox: malformed command matrices cannot mint, debit, queue work or poison prototypes", async t => {
  const actor = player(), before = saved(actor), base = command(actor);
  const cases = [null, [], true, 1, "{}", { ...base, coins: 1_000_000 }, { ...base, wallet: { coins: 1_000_000 } },
    { ...base, action: "grant_currency" }, { ...base, ownerPublicId: "' OR 1=1--" }, { ...base, requestId: "not-a-uuid" },
    { ...base, targetId: "" }, { ...base, targetId: "a".repeat(81) }, { ...base, fishSelection: { berries: -1 } },
    JSON.parse(JSON.stringify(base).replace(/}$/, ',"__proto__":{"polluted":true}}')),
    { ...base, constructor: { prototype: { polluted: true } } }];
  for (const field of ["quantity", "expectedRevision", "totalPrice"]) for (const value of [-1, 0.5, "1", null, {}, [], Number.MAX_SAFE_INTEGER + 1]) cases.push({ ...base, [field]: value });
  cases.push({ ...base, quantity: 0 }, { ...base, quantity: 10001 }, { ...base, totalPrice: 1_000_000_001 }, { ...base, expectedRevision: Number.MAX_SAFE_INTEGER });
  for (const body of cases) { await rejected(await post(actor, "economy", body), [400]); assert.deepEqual(saved(actor), before); }
  assert.equal(Object.prototype.polluted, undefined); assert.equal({}.polluted, undefined);
  assert.equal((await accepted(await post(actor, "economy", base))).state.jobs.length, 1, "ordinary play recovers after every rejection");
  t.diagnostic(`${cases.length} malformed payloads rejected without any profile or receipt mutation; ordinary command then accepted`);
});

test("sandbox: hostile identifiers through eight economy actions stay data and leave both accounts unchanged", async t => {
  const actor = player(), victim = player(), before = saved(actor), victimBefore = saved(victim);
  const actions = ["start_production", "start_construction", "claim_job", "sell", "equip_fishing_rod", "buy_wardrobe_item", "eat_food", "complete_resident_order"];
  let count = 0;
  for (const targetId of injections) for (const action of actions) {
    await rejected(await post(actor, "economy", command(actor, { action, targetId })));
    assert.deepEqual(saved(actor), before, `${action}/${targetId}`); assert.deepEqual(saved(victim), victimBefore); count++;
  }
  assert.equal((await accepted(await post(actor, "economy", command(actor)))).state.jobs.length, 1);
  t.diagnostic(`${count} hostile-identifier cases; this tests input behavior, not PostgreSQL injection resistance`);
});

test("sandbox: missing sessions, foreign owner envelopes and cross-site headers fail without spending", async t => {
  const actor = player(), victim = player(), before = saved(actor), victimBefore = saved(victim), base = command(actor);
  await rejected(await post(null, "economy", base), [401]);
  await rejected(await post(actor, "economy", { ...base, ownerPublicId: victim.me.user.publicId }), [409]);
  let count = 2;
  for (const headers of [{ Origin: "https://evil.example" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" },
    { "X-Game-Presence": victim.presenceId }, { "X-Game-Presence": "' OR 1=1--" }, { "X-Game-Presence": "" }]) {
    await rejected(await post(actor, "economy", base, headers), [403, 409]); count++;
  }
  assert.deepEqual(saved(actor), before); assert.deepEqual(saved(victim), victimBefore);
  assert.equal((await accepted(await post(actor, "economy", base))).state.jobs.length, 1);
  t.diagnostic(`${count} access-boundary cases followed by a healthy command`);
});

test("sandbox: concurrent retry bursts spend one item once and UUID payload tampering never changes its receipt", async t => {
  const actor = player(); profile(actor).state.inventory = { berries: 30 };
  const before = saved(actor), base = command(actor, { action: "sell", targetId: "berries" });
  const results = await Promise.all(Array.from({ length: 24 }, () => post(actor, "economy", base).then(accepted)));
  assert.equal(results.filter(result => !result.replayed).length, 1);
  assert.equal(profile(actor).state.inventory.berries, 29); assert.equal(profile(actor).receipts.size, 1);
  assert.equal(profile(actor).revision, before.revision + 1);
  const committed = saved(actor);
  const mutations = [{ quantity: 2 }, { targetId: "wood" }, { action: "sell_fish" }, { expectedRevision: committed.revision }, { totalPrice: 1 }];
  for (const extra of mutations) { const error = await rejected(await post(actor, "economy", { ...base, ...extra }), [409]); assert.equal(error.code, "ECONOMY_REQUEST_CONFLICT"); }
  assert.deepEqual(saved(actor), committed);
  const retry = await accepted(await post(actor, "economy", { ...base, requestId: base.requestId.toUpperCase() }));
  assert.equal(retry.replayed, true); assert.deepEqual(saved(actor), committed);
  await accepted(await post(actor, "economy", command(actor, { action: "sell", targetId: "berries" })));
  assert.equal(profile(actor).state.inventory.berries, 28); assert.equal(profile(actor).receipts.size, 2);
  t.diagnostic("24 overlapping identical handlers, 5 tampered receipts, uppercase UUID retry and recovery sale; no real DB concurrency claim");
});

function trader(inventory = {}) {
  const actor = player(), state = profile(actor).state;
  Object.assign(state.buildings, { home: 4, bridge: 1, warehouse: 10 });
  state.wallet.coins = 20_000; state.inventory = inventory; state.unlockedItems = Object.keys(inventory);
  return actor;
}
test("sandbox: competing buyers and late seller cancellation conserve an escrowed market lot and its exact payment", async t => {
  const seller = trader({ berries: 10 }), buyers = [trader({ berries: 1 }), trader({ berries: 1 })];
  const actors = [seller, ...buyers], totalBefore = actors.reduce((total, actor) => total + profile(actor).state.wallet.coins, 0);
  const quantity = 4, price = marketMinimumPrice("berries", quantity);
  const lot = (await accepted(await post(seller, "market", command(seller, { action: "create_listing", targetId: "berries", quantity, totalPrice: price })))).listing;
  for (const buyer of buyers) assert.equal(economy.getDevEconomyMarket(buyer.token).listings[0].id, lot.id);
  const beforeAttacks = actors.map(saved);
  for (const buyer of buyers) {
    await rejected(await post(buyer, "market", command(buyer, { action: "cancel_listing", targetId: lot.id })), [403]);
    for (const extra of [{ quantity: 1 }, { totalPrice: 0 }, { totalPrice: price - 1 }, { totalPrice: price + 1 }])
      await rejected(await post(buyer, "market", command(buyer, { action: "buy_listing", targetId: lot.id, quantity, totalPrice: price, ...extra })), [400, 409]);
  }
  actors.forEach((actor, index) => assert.deepEqual(saved(actor), beforeAttacks[index]));
  const jobs = buyers.flatMap(buyer => Array.from({ length: 12 }, () => ({ actor: buyer, body: command(buyer, { action: "buy_listing", targetId: lot.id, quantity, totalPrice: price }) })));
  const results = await Promise.all(jobs.map(async job => ({ ...job, response: await post(job.actor, "market", job.body) })));
  const winners = results.filter(result => result.response.status === 200); assert.equal(winners.length, 1);
  const winner = winners[0]; await accepted(winner.response);
  for (const result of results.filter(result => result !== winner)) await rejected(result.response, [409]);
  await rejected(await post(seller, "market", command(seller, { action: "cancel_listing", targetId: lot.id })), [409]);
  assert.equal(profile(seller).state.inventory.berries, 6);
  assert.equal(actors.reduce((sum, actor) => sum + profile(actor).state.inventory.berries, 0), 12);
  const fee = marketSaleFee(price, lot.feeBps);
  assert.equal(actors.reduce((sum, actor) => sum + profile(actor).state.wallet.coins, 0), totalBefore - fee);
  assert.equal(profile(seller).state.wallet.coins, 20_000 + price - fee);
  assert.equal(profile(winner.actor).state.wallet.coins, 20_000 - price);
  const after = actors.map(saved);
  assert.equal((await accepted(await post(winner.actor, "market", winner.body))).replayed, true);
  actors.forEach((actor, index) => assert.deepEqual(saved(actor), after[index]));
  await accepted(await post(seller, "economy", command(seller, { action: "sell", targetId: "berries" })));
  t.diagnostic("10 quote/ownership attacks, 24 overlapping buy handlers, late cancellation and receipt retry; lot and currency conserved");
});

test("sandbox: barter guesses, cross-endpoint receipt reuse and competing acceptances cannot duplicate rare items", async t => {
  const [first, second] = economyCatalog.items.filter(item => item.category === "special").map(item => item.id);
  const seller = trader({ [first]: 2 }), buyers = [trader({ [second]: 2 }), trader({ [second]: 2 })], actors = [seller, ...buyers];
  const barter = (actor, extra) => ({ requestId: uuid(), ownerPublicId: actor.me.user.publicId, expectedRevision: profile(actor).revision, ...extra });
  const create = barter(seller, { action: "create_offer", offeredItemId: first, requestedItemId: second });
  const offer = (await accepted(await post(seller, "barter", create))).offer;
  const beforeAttacks = actors.map(saved);
  for (const buyer of buyers) {
    await rejected(await post(buyer, "barter", barter(buyer, { action: "cancel_offer", offerId: offer.id })), [403]);
    await rejected(await post(buyer, "barter", barter(buyer, { action: "accept_offer", offerId: offer.id })), [409]);
    for (const offeredItemId of injections) await rejected(await post(buyer, "barter", barter(buyer, { action: "create_offer", offeredItemId, requestedItemId: first })), [400]);
  }
  await rejected(await post(seller, "economy", command(seller, { requestId: create.requestId, action: "sell", targetId: first })), [409]);
  actors.forEach((actor, index) => assert.deepEqual(saved(actor), beforeAttacks[index]));
  for (const buyer of buyers) assert.equal(economy.getDevEconomyBarter(buyer.token).offers[0].id, offer.id);
  const jobs = buyers.flatMap(buyer => Array.from({ length: 10 }, () => ({ actor: buyer, body: barter(buyer, { action: "accept_offer", offerId: offer.id }) })));
  const results = await Promise.all(jobs.map(async job => ({ ...job, response: await post(job.actor, "barter", job.body) })));
  const winners = results.filter(result => result.response.status === 200); assert.equal(winners.length, 1);
  const winner = winners[0]; await accepted(winner.response);
  for (const result of results.filter(result => result !== winner)) await rejected(result.response, [409]);
  assert.equal(actors.reduce((sum, actor) => sum + (profile(actor).state.inventory[first] ?? 0), 0), 2);
  assert.equal(actors.reduce((sum, actor) => sum + (profile(actor).state.inventory[second] ?? 0), 0), 4);
  const after = actors.map(saved);
  assert.equal((await accepted(await post(winner.actor, "barter", winner.body))).replayed, true);
  actors.forEach((actor, index) => assert.deepEqual(saved(actor), after[index]));
  await accepted(await post(seller, "economy", command(seller)));
  t.diagnostic("29 ownership/showcase/injection/receipt attacks and 20 competing acceptances; exact rare-item conservation and healthy next command");
});

test("sandbox: mail query and read tampering cannot expose or mark another account's letter or mint attached rewards", async t => {
  const actor = player(), victim = player(), id = uuid(), createdAt = "2026-10-18T00:00:00Z";
  mail.seedDevMailForTests(victim.me.user.publicId, [{ id, type: "admin_grant", title: "Секретное письмо", body: "Только получателю", createdAt,
    readAt: null, notify: true, attachments: { coins: 1000, pearls: 100, items: { wood: 50 } } }]);
  const actorBefore = saved(actor), victimBefore = saved(victim);
  const list = (who, query) => context.run({ token: who?.token }, () => routes.mail.GET(request(who, `/api/v1/mail?${query}`, undefined, {}, "GET")));
  const read = (who, owner, rawId = id, body = { expectedOwnerPublicId: owner }) => context.run({ token: who?.token }, () => routes.readMail.POST(
    request(who, `/api/v1/mail/${rawId}/read`, body), { params: Promise.resolve({ id: rawId }) }));
  await rejected(await list(actor, `expectedOwnerPublicId=${victim.me.user.publicId}`), [409]);
  await rejected(await read(actor, victim.me.user.publicId), [409]);
  await rejected(await read(actor, actor.me.user.publicId), [404]);
  await rejected(await read(null, victim.me.user.publicId), [401]);
  const own = `expectedOwnerPublicId=${victim.me.user.publicId}`;
  const queries = [`${own}&${own}`, `${own}&limit=-1`, `${own}&limit=0`, `${own}&limit=51`, `${own}&limit=1e1`, `${own}&limit=9007199254740992`,
    `${own}&limit=20&limit=1`, `${own}&admin=true`, `${own}&cursor=`, `${own}&cursor=${"a".repeat(161)}`,
    ...injections.map(value => `${own}&cursor=${encodeURIComponent(value)}`)];
  for (const query of queries) await rejected(await list(victim, query), [400]);
  for (const rawId of injections) await rejected(await read(victim, victim.me.user.publicId, rawId), [400]);
  for (const body of [{ expectedOwnerPublicId: victim.me.user.publicId, coins: 1_000_000 }, { expectedOwnerPublicId: victim.me.user.publicId, readAt: "1970-01-01T00:00:00Z" }])
    await rejected(await read(victim, victim.me.user.publicId, id, body), [400]);
  const pending = await accepted(await list(victim, own)); assert.equal(pending.unreadCount, 1); assert.equal(pending.messages[0].readAt, null);
  const acknowledgements = await Promise.all(Array.from({ length: 20 }, () => read(victim, victim.me.user.publicId).then(accepted)));
  assert.equal(new Set(acknowledgements.map(result => result.readAt)).size, 1);
  assert.equal((await accepted(await list(victim, own))).unreadCount, 0);
  assert.deepEqual(saved(actor), actorBefore); assert.deepEqual(saved(victim), victimBefore);
  t.diagnostic(`${4 + queries.length + injections.length + 2} rejected mail attacks, 20 overlapping read acknowledgements; balances unchanged including attachments`);
});

test("sandbox: mailbox enforces actual streamed bytes, handles disconnects and remains usable afterward", async t => {
  const actor = player(), id = uuid(), createdAt = "2026-10-18T00:00:00Z";
  mail.seedDevMailForTests(actor.me.user.publicId, [{ id, type: "admin_notice", title: "Проверка", body: "Прочитать позже", createdAt, readAt: null, notify: false, attachments: null }]);
  const invoke = (body, headers = {}) => context.run({ token: actor.token }, () => routes.readMail.POST(request(actor, `/api/v1/mail/${id}/read`, body, headers), { params: Promise.resolve({ id }) }));
  const encoder = new TextEncoder(); let cancelled = false;
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(" ".repeat(700))); controller.enqueue(encoder.encode(" ".repeat(700))); }, cancel() { cancelled = true; } });
  await rejected(await invoke(oversized, { "Content-Length": "1" }), [413]); assert.equal(cancelled, true);
  const disconnected = new ReadableStream({ start(controller) { controller.error(new Error("synthetic disconnected client")); } });
  await rejected(await invoke(disconnected), [400]);
  for (const text of ["{", '{"expectedOwnerPublicId":', "[1,2,3]", "null", "{\"__proto__\":{\"polluted\":true}}"])
    await rejected(await invoke(text), [400]);
  await rejected(await invoke({ expectedOwnerPublicId: actor.me.user.publicId }, { "Content-Type": "application/jsonp" }), [415]);
  const before = mail.getDevMail(actor.token, actor.me.user.publicId, undefined).value; assert.equal(before.unreadCount, 1);
  const valid = JSON.stringify({ expectedOwnerPublicId: actor.me.user.publicId });
  const chunked = new ReadableStream({ start(controller) { for (const character of valid) controller.enqueue(encoder.encode(character)); controller.close(); } });
  const result = await accepted(await invoke(chunked)); assert.equal(result.unreadCount, 0); assert.equal(Object.prototype.polluted, undefined);
  t.diagnostic("8 malformed or interrupted stream cases, then a valid one-byte-chunk request");
});

test("sandbox: economy rejects a streamed overflow before consuming the remaining request and handles a disconnected body", async t => {
  const actor = player(), before = saved(actor), encoder = new TextEncoder(); let pulls = 0, cancelled = false;
  const overflowing = new ReadableStream({ pull(controller) {
    if (++pulls <= 32) controller.enqueue(encoder.encode(" ".repeat(2048))); else controller.close();
  }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  await rejected(await post(actor, "economy", overflowing, { "Content-Length": "1" }), [413]);
  assert.ok(pulls <= 3, `4096-byte limit must stop after the third 2048-byte chunk, consumed ${pulls}`);
  assert.equal(cancelled, true); assert.deepEqual(saved(actor), before);
  const disconnected = new ReadableStream({ start(controller) { controller.error(new Error("synthetic disconnected client")); } });
  await rejected(await post(actor, "economy", disconnected), [400]);
  assert.deepEqual(saved(actor), before);
  await accepted(await post(actor, "economy", command(actor)));
  t.diagnostic("stream overflow stops at the existing byte cap; disconnected-body errors are contained and the next command succeeds");
});

test("sandbox: bounded body reader preserves exact existing limits for normal economy, market and barter commands", async t => {
  const encoder = new TextEncoder();
  const [first, second] = economyCatalog.items.filter(item => item.category === "special").map(item => item.id);
  for (const [name, limit] of [["economy", 4096], ["market", 2048], ["barter", 2048]]) {
    const actor = trader({ berries: 4, [first]: 1 });
    const payload = name === "economy" ? command(actor) : name === "market"
      ? command(actor, { action: "create_listing", targetId: "berries", totalPrice: marketMinimumPrice("berries", 1) })
      : { requestId: uuid(), ownerPublicId: actor.me.user.publicId, expectedRevision: profile(actor).revision,
        action: "create_offer", offeredItemId: first, requestedItemId: second };
    const text = JSON.stringify(payload), exact = text + " ".repeat(limit - encoder.encode(text).byteLength), before = saved(actor);
    const stream = value => new ReadableStream({ start(controller) {
      const bytes = encoder.encode(value);
      for (let offset = 0; offset < bytes.length; offset += 17) controller.enqueue(bytes.subarray(offset, offset + 17));
      controller.close();
    } });
    await rejected(await post(actor, name, stream(exact + " "), { "Content-Length": "1" }), [413]);
    assert.deepEqual(saved(actor), before);
    const result = await accepted(await post(actor, name, stream(exact)));
    assert.equal(result.acceptedRevision, before.revision + 1); assert.equal(result.replayed, false);
  }
  t.diagnostic("4096/2048/2048 byte boundaries: one-byte overflow rejected and exact-limit normal action accepted for all three handlers");
});

test("sandbox: public web admin fallback never grants authority from forged headers, IDs or environment mode", async t => {
  const actor = player(), before = saved(actor); let count = 0;
  for (const mode of ["test", "development", "production"]) {
    process.env.NODE_ENV = mode;
    for (const path of ["access", "users", "mail/broadcast", `users/${actor.me.user.publicId}/adjust-economy`]) for (const method of ["GET", "POST"]) {
      const response = await context.run({ token: actor.token }, () => routes.admin[method](request(actor, `/api/v1/admin/${path}`,
        method === "POST" ? { role: "admin", publicId: actor.me.user.publicId, coinsDelta: 1_000_000 } : undefined,
        { "X-Admin": "true", "X-User-Id": actor.me.user.publicId, "X-Forwarded-For": "127.0.0.1", Authorization: "Bearer admin" }, method)));
      assert.equal(response.status, 503); assert.equal((await response.json()).code, "ADMIN_UNAVAILABLE"); count++;
    }
  }
  assert.deepEqual(saved(actor), before);
  t.diagnostic(`${count} denied admin fallback combinations; Ktor administrator authentication requires its separate backend suite`);
  t.diagnostic(`${handlerRequests} total local HTTP-handler requests in the executed sandbox cases, including setup and healthy recovery requests`);
});

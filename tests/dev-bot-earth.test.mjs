import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), originalMode = process.env.NODE_ENV;
const cookieModule = "\0dev-bot-earth-cookie";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root, "next/headers": cookieModule } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "dev-bot-earth-cookie", resolveId(id) { if (id === cookieModule) return id; },
    load(id) { if (id === cookieModule) return "export async function cookies(){return {get(){return {value:globalThis.__devBotEarthToken}}}}"; } }],
});
const social = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const bots = await vite.ssrLoadModule("/lib/dev/bot-store.ts");
const earth = await vite.ssrLoadModule("/lib/dev/earth-sharing-store.ts");
const { devEarthSharingState } = await vite.ssrLoadModule("/lib/dev/earth-sharing-state.ts");
const { devBotEarthSimulation } = await vite.ssrLoadModule("/lib/dev/bot-earth-state.ts");
const model = await vite.ssrLoadModule("/features/world/dev/dev-bot-model.ts");
const { commandDevPresence } = await vite.ssrLoadModule("/lib/dev/activity-store.ts");
const route = await vite.ssrLoadModule("/app/api/v1/dev/bots/route.ts");
const uuid = () => crypto.randomUUID();
const ok = result => { assert.equal(result.kind, "ok", JSON.stringify(result)); return result.value; };
const player = () => social.createDevIdentity("Разработчик", uuid());
const command = (owner, action) => ({ ownerPublicId: owner.me.user.publicId, requestId: uuid(), ...action });
const act = (owner, action) => bots.commandDevBots(owner.token, command(owner, action));
const create = owner => act(owner, { action: "create", displayName: "Синтетический сосед", homeLevel: 2 }).snapshot.bots[0];
const read = (owner, bot) => bots.getDevBots(owner.token).bots.find(item => item.id === bot.id);
const feed = owner => ok(earth.getDevEarthPeople(owner.token)).people;
const move = (owner, bot, latitude = 55.752345, longitude = 37.623123) => act(owner, { action: "set_earth_position", botId: bot.id,
  latitude, longitude, accuracyMeters: 12 });
const sharing = (owner, bot, mode = "SHARING", values = {}) => act(owner, { action: "set_earth_sharing", botId: bot.id,
  mode, precision: "PRECISE", durationMinutes: 60, ...values });
function connect(first, second) {
  const request = ok(social.sendDevDirectRequest(first.token, second.me.user.publicId, uuid()));
  return ok(social.actOnDevDirectRequest(second.token, request.request.requestId, "ACCEPTED")).person.circleId;
}
function post(body, presence, headers = {}) {
  return new Request("http://localhost:3000/api/v1/dev/bots", { method: "POST", headers: { Origin: "http://localhost:3000",
    "Content-Type": "application/json", "X-Game-Presence": presence, ...headers }, body: JSON.stringify(body) });
}
beforeEach(() => {
  process.env.NODE_ENV = "development"; social.resetDevStoreForTests(); delete globalThis.__zhivDevBotReceipts;
  delete globalThis.__devBotEarthToken;
});
after(async () => {
  social.resetDevStoreForTests(); delete globalThis.__devBotEarthToken;
  if (originalMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalMode;
  await vite.close();
});

test("synthetic drafts default private and explicit sharing reaches only the real authorized owner feed", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T12:00:00Z") });
  const owner = player(), outsider = player(), bot = create(owner), privateBot = social.getDevOwnedBots(owner.token)[0];
  connect({ token: privateBot.token, me: social.getDevIdentity(privateBot.token) }, outsider);
  assert.deepEqual(bot.earth, { mode: "OFF", precision: "APPROXIMATE", sharingUntil: null, position: null,
    sharedUpdatedAt: null, sharedExpiresAt: null, nextPublishAt: null });
  move(owner, bot);
  assert.equal(read(owner, bot).earth.position.latitude, 55.752345);
  assert.deepEqual(feed(owner), []); assert.deepEqual(feed(outsider), []);
  const enabled = sharing(owner, bot, "SHARING", { precision: "APPROXIMATE" }).snapshot.bots[0];
  const point = feed(owner)[0];
  assert.equal(point.user.publicId, bot.publicId); assert.equal(point.circleId, bot.circleId);
  assert.equal(point.latitude, 55.75); assert.equal(point.longitude, 37.62); assert.equal(point.accuracyMeters, 1500);
  assert.equal(point.precision, "APPROXIMATE"); assert.deepEqual(feed(outsider), []);
  assert.deepEqual(ok(earth.getDevEarthSharing(privateBot.token)).recipientCircleIds, [bot.circleId]);
  assert.equal(ok(earth.getDevEarthSharing(owner.token)).mode, "OFF", "the viewer never starts their own GPS or consent");
  assert.equal(enabled.earth.sharedUpdatedAt, point.updatedAt); assert.equal(enabled.earth.sharedExpiresAt, point.expiresAt);
  assert.equal(Date.parse(enabled.earth.nextPublishAt) - Date.parse(point.updatedAt), 30_000);
  assert.equal(model.devBotSchema.safeParse(enabled).success, true);
  const serialized = JSON.stringify(enabled);
  for (const secret of [privateBot.token, "publicationEpoch", "publisherSession", "sequence"]) assert.equal(serialized.includes(secret), false, secret);
});

test("explicit map placement shows a new bot at the exact chosen center only to its owner", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T12:00:00Z") });
  const owner = player(), stranger = player(), bot = create(owner), privateBot = social.getDevOwnedBots(owner.token)[0];
  connect({ token: privateBot.token, me: social.getDevIdentity(privateBot.token) }, stranger);
  const cmd = command(owner, { action: "set_earth_position", botId: bot.id,
    latitude: 55.752345, longitude: 37.623123, accuracyMeters: 20, showOnMap: true });
  const result = bots.commandDevBots(owner.token, cmd), placed = result.snapshot.bots[0];
  assert.equal(placed.earth.mode, "SHARING"); assert.equal(placed.earth.precision, "PRECISE");
  assert.equal(feed(owner)[0].latitude, cmd.latitude); assert.equal(feed(owner)[0].longitude, cmd.longitude);
  assert.deepEqual(feed(stranger), []);
  assert.equal(ok(earth.getDevEarthSharing(owner.token)).mode, "OFF", "the actual viewer never grants their own location");
  assert.deepEqual(ok(earth.getDevEarthSharing(privateBot.token)).recipientCircleIds, [bot.circleId]);
  const first = feed(owner)[0];
  t.mock.timers.tick(1000);
  assert.equal(bots.commandDevBots(owner.token, cmd).replayed, true);
  assert.deepEqual(feed(owner), [first], "an exact-command retry cannot heartbeat a point");
  assert.throws(() => act(owner, { ...cmd, requestId: uuid(), longitude: 38 }), { code: "EARTH_RATE_LIMITED" });
  assert.deepEqual(feed(owner), [first], "placing again cannot bypass the normal publication cadence");
  assert.throws(() => act(stranger, { ...cmd, requestId: uuid(), ownerPublicId: stranger.me.user.publicId }), { code: "DEV_BOT_NOT_FOUND" });
});

test("placing a ghost again explicitly resumes only the synthetic bot; private moves still preserve ghost", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T12:00:00Z") });
  const owner = player(), bot = create(owner); move(owner, bot); sharing(owner, bot); sharing(owner, bot, "GHOST");
  const previous = feed(owner)[0]; move(owner, bot, 40.7, -74);
  assert.deepEqual(feed(owner), [previous]);
  const placed = act(owner, { action: "set_earth_position", botId: bot.id,
    latitude: 48.85837, longitude: 2.294481, accuracyMeters: 20, showOnMap: true }).snapshot.bots[0];
  assert.equal(placed.earth.mode, "SHARING"); assert.equal(feed(owner)[0].latitude, 48.85837);
  assert.equal(feed(owner)[0].longitude, 2.294481);
});

test("normal publication cadence and exact replay prevent moves, reads or retries from heartbeating a point", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T12:00:00Z") });
  const owner = player(), bot = create(owner); move(owner, bot); sharing(owner, bot);
  const first = feed(owner)[0], draft = read(owner, bot).earth.position;
  t.mock.timers.tick(1);
  assert.throws(() => move(owner, bot, 55.8, 37.7), { code: "EARTH_RATE_LIMITED", status: 429 });
  assert.deepEqual(read(owner, bot).earth.position, draft); assert.deepEqual(feed(owner), [first]);
  t.mock.timers.tick(29_999);
  const cmd = command(owner, { action: "set_earth_position", botId: bot.id, latitude: 55.8, longitude: 37.7, accuracyMeters: 8 });
  const moved = bots.commandDevBots(owner.token, cmd), second = feed(owner)[0];
  assert.equal(second.latitude, 55.8); assert.equal(second.longitude, 37.7);
  assert.equal(Date.parse(second.updatedAt) - Date.parse(first.updatedAt), 30_000);
  t.mock.timers.tick(45_000);
  assert.equal(bots.commandDevBots(owner.token, cmd).replayed, true);
  assert.deepEqual(feed(owner), [second]); assert.equal(read(owner, bot).earth.sharedExpiresAt, moved.snapshot.bots[0].earth.sharedExpiresAt);
  assert.throws(() => bots.commandDevBots(owner.token, { ...cmd, latitude: 56 }), { code: "DEV_BOT_REQUEST_CONFLICT" });
  const receipt = globalThis.__zhivDevBotReceipts.get(owner.me.user.publicId).get(cmd.requestId);
  assert.match(receipt.signature, /^[0-9a-f]{64}$/); assert.equal(JSON.stringify(receipt).includes("55.8"), false);
});

test("ghost freezes the already shared point while synthetic movement stays private until explicit resume", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T12:00:00Z") });
  const owner = player(), bot = create(owner); move(owner, bot); sharing(owner, bot);
  const first = feed(owner)[0], deadline = read(owner, bot).earth.sharingUntil;
  t.mock.timers.tick(1_000);
  sharing(owner, bot, "GHOST", { precision: "APPROXIMATE", durationMinutes: null });
  const changed = move(owner, bot, 56.1, 38.2).snapshot.bots[0].earth;
  assert.equal(changed.mode, "GHOST"); assert.equal(changed.position.latitude, 56.1); assert.equal(changed.nextPublishAt, null);
  assert.equal(changed.sharingUntil, deadline); assert.equal(changed.precision, "PRECISE");
  assert.equal(changed.sharedUpdatedAt, first.updatedAt); assert.equal(changed.sharedExpiresAt, first.expiresAt);
  t.mock.timers.tick(60_000);
  assert.deepEqual(feed(owner), [first]); assert.equal(read(owner, bot).earth.sharedUpdatedAt, first.updatedAt);
  sharing(owner, bot);
  assert.equal(feed(owner)[0].latitude, 56.1); assert.equal(feed(owner)[0].longitude, 38.2);
  assert.ok(Date.parse(feed(owner)[0].updatedAt) > Date.parse(first.updatedAt));
  sharing(owner, bot, "OFF"); assert.deepEqual(feed(owner), []);
  move(owner, bot, -33.9, 151.2); assert.deepEqual(feed(owner), []);
  sharing(owner, bot, "GHOST"); assert.deepEqual(feed(owner), [], "ghost cannot resurrect revoked consent");
});

test("timed consent expires naturally without background publishers and requires new explicit access", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T12:00:00Z") });
  const owner = player(), bot = create(owner); move(owner, bot); sharing(owner, bot); sharing(owner, bot, "GHOST");
  t.mock.timers.tick(3_600_000);
  assert.deepEqual(feed(owner), []); const expired = read(owner, bot).earth;
  assert.equal(expired.mode, "OFF"); assert.equal(expired.sharedUpdatedAt, null); assert.equal(expired.nextPublishAt, null);
  move(owner, bot, 40.7, -74); assert.deepEqual(feed(owner), []);
  sharing(owner, bot); assert.equal(feed(owner)[0].latitude, 40.7);
  assert.equal(Date.parse(feed(owner)[0].updatedAt), Date.now());
});

test("bot controls preserve owner isolation and cannot restore a revoked friendship or invalidated publisher", () => {
  const owner = player(), stranger = player(), bot = create(owner); move(owner, bot); sharing(owner, bot);
  for (const action of [{ action: "set_earth_position", latitude: 1, longitude: 2, accuracyMeters: 5 },
    { action: "set_earth_sharing", mode: "OFF", precision: "PRECISE", durationMinutes: 60 }, { action: "check_in" }]) {
    assert.throws(() => act(stranger, { ...action, botId: bot.id }), { code: "DEV_BOT_NOT_FOUND", status: 404 });
  }
  const foreign = command(owner, { action: "set_earth_position", botId: bot.id, latitude: 1, longitude: 2, accuracyMeters: 5 });
  assert.throws(() => bots.commandDevBots(stranger.token, foreign), { code: "DEV_BOT_OWNER_CHANGED" });
  ok(social.removeDevPerson(owner.token, bot.circleId));
  assert.deepEqual(feed(owner), []); assert.equal(read(owner, bot).earth.nextPublishAt, null);
  assert.throws(() => move(owner, bot, 1, 2), { code: "DEV_BOT_EARTH_PAUSED" });
  assert.throws(() => sharing(owner, bot), { code: "INVALID_EARTH_SHARING" });
  assert.deepEqual(feed(owner), []);
});

test("bot deletion and local reset clear synthetic inputs and the normal Earth capability and points", () => {
  const owner = player(), bot = create(owner); move(owner, bot); sharing(owner, bot);
  const privateBot = social.getDevOwnedBots(owner.token)[0], state = devEarthSharingState().owners.get(bot.publicId);
  assert.ok(devBotEarthSimulation(privateBot).position); assert.ok(state.position); assert.ok(state.publicationEpoch);
  act(owner, { action: "delete", botId: bot.id });
  assert.deepEqual(feed(owner), []); assert.equal(state.position, null); assert.equal(state.publicationEpoch, null);
  assert.equal(devBotEarthSimulation(privateBot).position, null);
  const other = create(owner); move(owner, other); sharing(owner, other);
  const privateOther = social.getDevOwnedBots(owner.token)[0];
  social.resetDevStoreForTests(); assert.equal(devEarthSharingState().owners.size, 0);
  assert.equal(devBotEarthSimulation(privateOther).position, null);
});

test("check-in uses the real bot event and cooldown without enabling, renewing or moving geo sharing", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T12:00:00Z") });
  const owner = player(), bot = create(owner); move(owner, bot);
  const cmd = command(owner, { action: "check_in", botId: bot.id });
  const checked = bots.commandDevBots(owner.token, cmd).snapshot.bots[0];
  assert.equal(checked.lastCheckInAt, new Date().toISOString()); assert.equal(checked.earth.mode, "OFF"); assert.deepEqual(feed(owner), []);
  assert.equal(ok(social.listDevPeople(owner.token)).people[0].lastCheckInAt, checked.lastCheckInAt);
  assert.equal(bots.commandDevBots(owner.token, cmd).replayed, true);
  assert.throws(() => act(owner, { action: "check_in", botId: bot.id }), { code: "CHECK_IN_COOLDOWN", status: 429 });
  sharing(owner, bot); sharing(owner, bot, "GHOST"); const frozen = feed(owner)[0];
  t.mock.timers.tick(30_000); act(owner, { action: "check_in", botId: bot.id });
  assert.deepEqual(feed(owner), [frozen]); assert.equal(read(owner, bot).earth.mode, "GHOST");
});

test("exhausted public read budgets cannot block ghost or revoke, their snapshots or exact HTTP replays", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T12:00:00Z") });
  const owner = player(), bot = create(owner), privateBot = social.getDevOwnedBots(owner.token)[0];
  move(owner, bot); sharing(owner, bot); const first = feed(owner)[0];
  const presence = uuid(); globalThis.__devBotEarthToken = owner.token;
  commandDevPresence(owner.me.user.publicId, { kind: "resume", presenceId: presence, sequence: 0, active: true }, Date.now(), owner.token);
  for (const token of [owner.token, privateBot.token]) {
    for (let index = 0; index < 600; index++) earth.getDevEarthSharing(token);
    assert.deepEqual(earth.getDevEarthSharing(token), { kind: "error", status: 429, code: "EARTH_RATE_LIMITED", retryAfterSeconds: 3600 });
    assert.equal(earth.getDevEarthPeople(token).status, 429, "the public feed still enforces its normal budget");
  }
  const budgets = structuredClone(devEarthSharingState().reads);
  const current = read(owner, bot);
  assert.equal(current.earth.sharedUpdatedAt, first.updatedAt); assert.equal(current.earth.sharedExpiresAt, first.expiresAt);
  const ghost = command(owner, { action: "set_earth_sharing", botId: bot.id, mode: "GHOST", precision: "APPROXIMATE", durationMinutes: null });
  const response = await route.POST(post(ghost, presence)); assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.replayed, false); assert.equal(result.snapshot.bots[0].earth.mode, "GHOST");
  assert.equal(result.snapshot.bots[0].earth.sharingUntil, current.earth.sharingUntil);
  assert.equal(result.snapshot.bots[0].earth.sharedUpdatedAt, first.updatedAt);
  assert.equal(result.snapshot.bots[0].earth.sharedExpiresAt, first.expiresAt);
  const record = devEarthSharingState().owners.get(bot.publicId), revision = record.revision;
  const replayResponse = await route.POST(post(ghost, presence)); assert.equal(replayResponse.status, 200);
  const replay = await replayResponse.json(); assert.equal(replay.replayed, true);
  assert.deepEqual(replay.snapshot, result.snapshot); assert.equal(record.revision, revision);
  assert.deepEqual(ok(earth.projectDevEarthPeople(owner.token)).people, [first]);
  const revoke = command(owner, { action: "set_earth_sharing", botId: bot.id, mode: "OFF", precision: "PRECISE", durationMinutes: 60 });
  const revokedResponse = await route.POST(post(revoke, presence)); assert.equal(revokedResponse.status, 200);
  const revoked = await revokedResponse.json(); assert.equal(revoked.snapshot.bots[0].earth.mode, "OFF");
  assert.equal(revoked.snapshot.bots[0].earth.sharedUpdatedAt, null); assert.equal(revoked.snapshot.bots[0].earth.sharedExpiresAt, null);
  assert.equal(record.position, null); assert.equal(record.publicationEpoch, null);
  const revokedReplay = await route.POST(post(revoke, presence)); assert.equal(revokedReplay.status, 200);
  assert.equal((await revokedReplay.json()).replayed, true);
  assert.deepEqual(ok(earth.projectDevEarthPeople(owner.token)).people, []);
  assert.equal(read(owner, bot).earth.mode, "OFF");
  assert.deepEqual(devEarthSharingState().reads, budgets, "internal projections spend no public read quota");
  assert.equal(earth.getDevEarthSharing(privateBot.token).status, 429); assert.equal(earth.getDevEarthPeople(owner.token).status, 429);
});

test("existing DEV HTTP boundary validates finite coordinates, auth, origin, presence and production gating", async () => {
  const owner = player(), bot = create(owner), presence = uuid(); globalThis.__devBotEarthToken = owner.token;
  commandDevPresence(owner.me.user.publicId, { kind: "resume", presenceId: presence, sequence: 0, active: true }, Date.now(), owner.token);
  const cmd = command(owner, { action: "set_earth_position", botId: bot.id, latitude: 1, longitude: 2, accuracyMeters: 5 });
  for (const values of [{ latitude: 91 }, { longitude: -181 }, { accuracyMeters: -1 }, { latitude: null }, { token: "private" }, { capturedAt: new Date().toISOString() }]) {
    assert.equal((await route.POST(post({ ...cmd, ...values }, presence))).status, 400);
  }
  assert.equal((await route.POST(post(cmd, presence, { Origin: "https://evil.test" }))).status, 403);
  assert.equal((await route.POST(post(cmd, uuid()))).status, 409);
  const accepted = await route.POST(post(cmd, presence)); assert.equal(accepted.status, 200); assert.equal(accepted.headers.get("cache-control"), "no-store");
  assert.equal((await accepted.json()).snapshot.bots[0].earth.position.latitude, 1); assert.deepEqual(feed(owner), []);
  delete globalThis.__devBotEarthToken; assert.equal((await route.POST(post(cmd, presence))).status, 401);
  process.env.NODE_ENV = "production";
  assert.equal((await route.POST(post(cmd, presence))).status, 503);
  assert.throws(() => bots.commandDevBots(owner.token, cmd), { code: "DEV_API_DISABLED" });
});

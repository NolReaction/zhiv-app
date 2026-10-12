import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const contract = await vite.ssrLoadModule("/features/notifications/notification-contract.ts");
const api = await vite.ssrLoadModule("/features/notifications/notification-api.ts");
const browser = await vite.ssrLoadModule("/features/notifications/notification-browser.ts");
const store = await vite.ssrLoadModule("/lib/dev/notifications-store.ts");
const identity = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const owner = "AAAA-0000-0001";
const initialGlobals = Object.fromEntries(["window", "navigator", "Notification", "localStorage", "fetch"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
function restoreBrowser() {
  for (const [key, value] of Object.entries(initialGlobals)) {
    if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key];
  }
}
beforeEach(() => { restoreBrowser(); identity.resetDevStoreForTests(); store.resetDevNotificationsForTests(); });
after(restoreBrowser);
function snapshot(overrides = {}) { return { ownerPublicId: owner, preferences: contract.defaultNotificationPreferences("Europe/Moscow"), delivery: { configured: true, publicKey: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url"), reason: null }, subscription: { subscribed: false }, ...overrides }; }
function fakeBrowser({ permission = "granted", ios = false, installed = true, secure = true, local = null } = {}) {
  browser.setActiveNotificationOwner(owner);
  const calls = [];
  const memory = new Map();
  let subscription = local;
  const make = () => ({ endpoint: "https://fcm.googleapis.com/delivery", toJSON: () => ({ endpoint: "https://fcm.googleapis.com/delivery", keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url"), auth: "a".repeat(22) } }), unsubscribe: async () => { calls.push("unsubscribe"); subscription = null; return true; } });
  const registration = { active: {}, pushManager: {
    getSubscription: async () => subscription,
    subscribe: async options => { calls.push(["subscribe", options.userVisibleOnly, options.applicationServerKey.byteLength]); subscription = make(); return subscription; },
  } };
  for (const [key, value] of Object.entries({
    window: { isSecureContext: secure, PushManager: {}, Notification: {}, matchMedia: () => ({ matches: installed }) },
    navigator: { userAgent: ios ? "iPhone" : "Desktop", platform: ios ? "iPhone" : "Linux", maxTouchPoints: 0, serviceWorker: { getRegistration: async () => { calls.push("registration"); return registration; } } },
    Notification: { permission: "default", requestPermission: () => { calls.push("permission"); return Promise.resolve(permission); } },
    localStorage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) },
    fetch: async (_url, options) => { if (options.method === "GET") return Response.json(snapshot({ subscription: { subscribed: Boolean(subscription) } })); calls.push(["api", JSON.parse(options.body)]); return Response.json(snapshot({ subscription: { subscribed: options.method !== "DELETE" } })); },
  })) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  return { calls, registration, make, memory };
}

test("defaults select useful game events without check-in nagging or device consent", () => {
  const prefs = contract.defaultNotificationPreferences("Europe/Moscow");
  assert.equal(prefs.constructionCompleted, true); assert.equal(prefs.explorationCompleted, true); assert.equal(prefs.productionCompleted, true); assert.equal(prefs.checkinReminder, false);
  assert.equal(prefs.maxPerDay, 2); assert.equal(prefs.minIntervalMinutes, 120); assert.equal(prefs.quietStart, "23:00"); assert.equal(prefs.quietEnd, "10:00");
  assert.equal(prefs.rateLimitsEnabled, false);
  assert.equal(prefs.quietHoursEnabled, true);
});

test("missing frequency preference defaults off while quiet hours and explicit choices remain independent", () => {
  const base = contract.defaultNotificationPreferences();
  const legacy = { ...base };
  delete legacy.rateLimitsEnabled;
  assert.equal(contract.notificationPreferencesSchema.parse(legacy).rateLimitsEnabled, false);
  for (const patch of [{ quietHoursEnabled: false }, { rateLimitsEnabled: false }, { rateLimitsEnabled: true }, { quietHoursEnabled: false, rateLimitsEnabled: true }]) {
    const parsed = contract.notificationPreferencesSchema.parse({ ...base, ...patch });
    assert.deepEqual(parsed, { ...base, ...patch });
  }
  assert.equal(contract.notificationPreferencesSchema.safeParse({ ...base, rateLimitsEnabled: "false" }).success, false);
});

test("notification API defaults missing frequency preference off and preserves both explicit choices", async () => {
  const legacy = snapshot();
  delete legacy.preferences.rateLimitsEnabled;
  globalThis.fetch = async () => Response.json(legacy);
  assert.equal((await api.getNotificationSettings(owner)).preferences.rateLimitsEnabled, false);
  for (const rateLimitsEnabled of [true, false]) {
    globalThis.fetch = async () => Response.json(snapshot({ preferences: { ...contract.defaultNotificationPreferences(), rateLimitsEnabled } }));
    assert.equal((await api.getNotificationSettings(owner)).preferences.rateLimitsEnabled, rateLimitsEnabled);
  }
});

test("preferences reject dangerous frequency, malformed clock, unknown settings and invalid zones", () => {
  const base = contract.defaultNotificationPreferences();
  for (const patch of [{ maxPerDay: 3 }, { minIntervalMinutes: 59 }, { minIntervalMinutes: 1441 }, { quietStart: "25:00" }, { quietEnd: "23:00" }, { timeZone: "fake/zone" }, { sendNow: true }, { constructionCompleted: "true" }]) {
    assert.equal(contract.notificationPreferencesSchema.safeParse({ ...base, ...patch }).success, false, JSON.stringify(patch));
  }
  assert.equal(contract.notificationPreferencesSchema.safeParse({ ...base, maxPerDay: 1, minIntervalMinutes: 1440 }).success, true);
});

test("DEV preference persistence is authenticated, owner-bound, isolated and honest about delivery", () => {
  const a = identity.createDevIdentity("Первый", crypto.randomUUID());
  const b = identity.createDevIdentity("Второй", crypto.randomUUID());
  assert.equal(store.getDevNotifications(undefined, a.me.user.publicId).kind, "unauthorized");
  assert.equal(store.getDevNotifications(a.token, b.me.user.publicId).kind, "owner-mismatch");
  const changed = { ...contract.defaultNotificationPreferences(), productionCompleted: false, checkinReminder: true, rateLimitsEnabled: false, quietHoursEnabled: false };
  assert.equal(store.saveDevNotificationPreferences(a.token, b.me.user.publicId, changed).kind, "owner-mismatch");
  const saved = store.saveDevNotificationPreferences(a.token, a.me.user.publicId, changed);
  assert.equal(saved.kind, "ok"); assert.equal(saved.value.delivery.configured, false); assert.equal(saved.value.subscription.subscribed, false);
  changed.maxPerDay = 1;
  assert.equal(store.getDevNotifications(a.token, a.me.user.publicId).value.preferences.maxPerDay, 2);
  assert.equal(store.getDevNotifications(a.token, a.me.user.publicId).value.preferences.productionCompleted, false);
  assert.equal(store.getDevNotifications(a.token, a.me.user.publicId).value.preferences.rateLimitsEnabled, false);
  assert.equal(store.getDevNotifications(a.token, a.me.user.publicId).value.preferences.quietHoursEnabled, false);
  assert.equal(store.getDevNotifications(b.token, b.me.user.publicId).value.preferences.rateLimitsEnabled, false);
  assert.equal(store.getDevNotifications(b.token, b.me.user.publicId).value.preferences.productionCompleted, true);
  assert.equal(store.getDevNotifications(b.token, b.me.user.publicId).value.preferences.checkinReminder, false);
  for (const rateLimitsEnabled of [true, false]) {
    store.saveDevNotificationPreferences(a.token, a.me.user.publicId, { ...changed, rateLimitsEnabled });
    assert.equal(store.getDevNotifications(a.token, a.me.user.publicId).value.preferences.rateLimitsEnabled, rateLimitsEnabled);
    assert.equal(store.getDevNotifications(b.token, b.me.user.publicId).value.preferences.rateLimitsEnabled, false);
  }
});

test("notification links permit only read-only app views and require an owner", () => {
  const origin = "https://zhiv.example";
  assert.deepEqual(browser.parseNotificationLink(`/?notification=world&section=activities&owner=${owner}`, origin), { ownerPublicId: owner, target: "activities" });
  assert.deepEqual(browser.parseNotificationLink(`/?notification=checkin&owner=${owner}`, origin), { ownerPublicId: owner, target: "checkin" });
  for (const value of ["https://evil.example/?notification=checkin&owner=a", "/api/v1/check-ins?notification=checkin&owner=a", "/?notification=world&section=sell&owner=a", "/?notification=checkin", "javascript:alert(1)"]) assert.equal(browser.parseNotificationLink(value, origin), null, value);
});

test("opening support detection never prompts; iOS installation and insecure context are explained", () => {
  const ios = fakeBrowser({ ios: true, installed: false });
  assert.equal(browser.notificationSupport().supported, false); assert.match(browser.notificationSupport().reason, /Домой/); assert.deepEqual(ios.calls, []);
  const insecure = fakeBrowser({ secure: false }); assert.match(browser.notificationSupport().reason, /HTTPS/); assert.deepEqual(insecure.calls, []);
});

test("unconfigured service never requests permission or reports a subscription", async () => {
  const fake = fakeBrowser();
  await assert.rejects(browser.connectPush(owner, snapshot({ delivery: { configured: false, publicKey: null, reason: "not_configured" } })), /ещё не подключена/);
  assert.deepEqual(fake.calls, []); assert.equal(browser.rememberedNotificationOwner(), null);
});

test("explicit connect asks permission before any await, sends browser keys and confirms server binding", async () => {
  const fake = fakeBrowser();
  const operation = browser.connectPush(owner, snapshot());
  assert.deepEqual(fake.calls, ["permission"]);
  const result = await operation;
  assert.equal(result.subscription.subscribed, true); assert.equal(browser.rememberedNotificationOwner(), owner);
  assert.deepEqual(fake.calls.find(call => Array.isArray(call) && call[0] === "subscribe"), ["subscribe", true, 65]);
  const api = fake.calls.find(call => Array.isArray(call) && call[0] === "api")[1];
  assert.equal(api.expectedOwnerPublicId, owner); assert.equal(api.subscription.endpoint, "https://fcm.googleapis.com/delivery");
});

test("declined permission never creates or sends a browser subscription", async () => {
  const fake = fakeBrowser({ permission: "default" });
  await assert.rejects(browser.connectPush(owner, snapshot()), /не включены/);
  assert.deepEqual(fake.calls, ["permission"]);
});

test("failed server binding removes the newly-created subscription instead of claiming enabled", async () => {
  const fake = fakeBrowser();
  globalThis.fetch = async (_url, options) => options.method === "GET" ? Response.json(snapshot()) : Response.json({ code: "PUSH_NOT_CONFIGURED", message: "Нет доставки" }, { status: 503 });
  await assert.rejects(browser.connectPush(owner, snapshot()), /Нет доставки/);
  assert.equal(browser.rememberedNotificationOwner(), null); assert.equal(fake.calls.at(-1), "unsubscribe");
});

test("account switch clears previous local subscription without subscribing the new account", async () => {
  const fake = fakeBrowser(); await browser.connectPush(owner, snapshot()); fake.calls.length = 0;
  await browser.clearPreviousNotificationOwner(owner); assert.deepEqual(fake.calls, []);
  browser.setActiveNotificationOwner("BBBB-0000-0002");
  await browser.clearPreviousNotificationOwner("BBBB-0000-0002");
  assert.deepEqual(fake.calls, ["registration", "unsubscribe"]); assert.equal(browser.rememberedNotificationOwner(), null);
});


test("account switch while permission is open aborts old connect before touching the new subscription", async () => {
  const fake = fakeBrowser(); let permit;
  globalThis.Notification.requestPermission = () => new Promise(resolve => { permit = resolve; });
  const connecting = browser.connectPush(owner, snapshot());
  browser.setActiveNotificationOwner("BBBB-0000-0002");
  permit("granted");
  await assert.rejects(connecting, /Профиль изменился/);
  assert.deepEqual(fake.calls, []);
});

test("an old account request cannot overwrite or unsubscribe the next account's completed connect", async () => {
  const fake = fakeBrowser(); let finishOld;
  globalThis.fetch = async (_url, options) => {
    if (options.method === "GET") return Response.json(snapshot({ ownerPublicId: new URL(_url, "https://zhiv.example").searchParams.get("expectedOwnerPublicId") }));
    const request = JSON.parse(options.body);
    if (request.expectedOwnerPublicId === owner) return new Promise(resolve => { finishOld = () => resolve(Response.json(snapshot({ subscription: { subscribed: true } }))); });
    return Response.json(snapshot({ ownerPublicId: request.expectedOwnerPublicId, subscription: { subscribed: true } }));
  };
  const old = browser.connectPush(owner, snapshot());
  while (!finishOld) await new Promise(resolve => setImmediate(resolve));
  const nextOwner = "BBBB-0000-0002";
  browser.setActiveNotificationOwner(nextOwner);
  const next = browser.connectPush(nextOwner, snapshot({ ownerPublicId: nextOwner }));
  finishOld();
  await assert.rejects(old, /Профиль изменился/);
  const result = await next;
  assert.equal(result.ownerPublicId, nextOwner); assert.equal(browser.rememberedNotificationOwner(), nextOwner);
  const lastSubscribe = fake.calls.findLastIndex(value => Array.isArray(value) && value[0] === "subscribe");
  assert.equal(fake.calls.slice(lastSubscribe + 1).includes("unsubscribe"), false);
});


test("DEV push validation matches production service allowlist and rejects credentials, ports and malformed keys", () => {
  const keys = { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") };
  for (const endpoint of ["https://fcm.googleapis.com/delivery", "https://web.push.apple.com/Qabc", "https://updates.push.services.mozilla.com/wpush/v2/abc"]) assert.equal(contract.notificationSubscriptionSchema.safeParse({ endpoint, keys }).success, true);
  for (const endpoint of ["http://fcm.googleapis.com/delivery", "https://localhost/delivery", "https://fcm.googleapis.com:443/delivery", "https://user@fcm.googleapis.com/delivery", "https://fcm.googleapis.com/delivery#fragment", "https://fcm.googleapis.com/", "https://fcm.googleapis.com.evil.example/delivery"]) assert.equal(contract.notificationSubscriptionSchema.safeParse({ endpoint, keys }).success, false, endpoint);
  assert.equal(contract.notificationSubscriptionSchema.safeParse({ endpoint: "https://fcm.googleapis.com/delivery", keys: { ...keys, p256dh: Buffer.alloc(65).toString("base64url") } }).success, false);
});


test("stale tab cannot unsubscribe another account after authentication changed in another tab", async () => {
  const fake = fakeBrowser();
  await browser.connectPush(owner, snapshot()); fake.calls.length = 0;
  // Another tab owns the browser subscription; this tab has not learned about its changed cookie.
  browser.rememberNotificationOwner("BBBB-0000-0002");
  globalThis.fetch = async () => Response.json({ code: "NOTIFICATION_OWNER_MISMATCH", message: "Профиль изменился" }, { status: 409 });
  await assert.rejects(browser.connectPush(owner, snapshot()), /Профиль изменился/);
  assert.deepEqual(fake.calls, ["permission"]);
  assert.equal(browser.rememberedNotificationOwner(), "BBBB-0000-0002");
});

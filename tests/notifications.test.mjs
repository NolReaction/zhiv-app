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
    subscribe: async options => {
      calls.push(["subscribe", options.userVisibleOnly, options.applicationServerKey.byteLength]);
      globalThis.Notification.permission = permission;
      if (permission !== "granted") throw new DOMException("The user denied permission", "NotAllowedError");
      subscription = make(); return subscription;
    },
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
  assert.equal(prefs.administrationMessages, true);
  assert.equal(prefs.quietHoursEnabled, true);
});

test("mail defaults on for saved legacy preferences and respects an explicit opt out without device consent", () => {
  const preferences = contract.defaultNotificationPreferences(), legacy = { ...preferences };
  delete legacy.administrationMessages;
  assert.equal(contract.notificationPreferencesSchema.parse(legacy).administrationMessages, true);
  assert.equal(contract.notificationPreferencesSchema.parse({ ...preferences, administrationMessages: false }).administrationMessages, false);
  assert.equal(contract.notificationPreferencesSchema.safeParse({ ...preferences, administrationMessages: "true" }).success, false);
  const p = identity.createDevIdentity("Тест", crypto.randomUUID());
  store.saveDevNotificationPreferences(p.token, p.me.user.publicId, { ...preferences, administrationMessages: false });
  const saved = store.getDevNotifications(p.token, p.me.user.publicId).value;
  assert.equal(saved.preferences.administrationMessages, false);
  assert.equal(saved.delivery.configured, false);
  assert.equal(saved.subscription.subscribed, false);
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
  assert.deepEqual(browser.parseNotificationLink(`/?notification=world&section=mine&owner=${owner}`, origin), { ownerPublicId: owner, target: "mine" });
  assert.deepEqual(browser.parseNotificationLink(`/?notification=checkin&owner=${owner}`, origin), { ownerPublicId: owner, target: "checkin" });
  assert.deepEqual(browser.parseNotificationLink(`/?notification=mailbox&owner=${owner}`, origin), { ownerPublicId: owner, target: "mailbox" });
  assert.deepEqual(browser.parseNotificationLink(`/?notification=mailbox&owner=${owner}&redirect=https://evil.example&claim=all`, origin), { ownerPublicId: owner, target: "mailbox" });
  for (const value of [`https://evil.example/?notification=mailbox&owner=${owner}`, "/api/v1/mail?notification=mailbox&owner=a", "/?notification=mailbox", "/?notification=world&section=mailbox&owner=a"])
    assert.equal(browser.parseNotificationLink(value, origin), null, value);
  for (const value of ["https://evil.example/?notification=checkin&owner=a", "/api/v1/check-ins?notification=checkin&owner=a", "/?notification=world&section=sell&owner=a", "/?notification=world&section=mine", "/?notification=checkin", "javascript:alert(1)"]) assert.equal(browser.parseNotificationLink(value, origin), null, value);
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

test("explicit connect subscribes directly in the gesture without a separate permission request", async () => {
  const fake = fakeBrowser();
  const prepared = await browser.preparePushConnection(owner);
  assert.deepEqual(fake.calls, ["registration"], "read-only preparation never prompts or subscribes");
  fake.calls.length = 0;
  let gesture = true;
  const subscribe = fake.registration.pushManager.subscribe;
  fake.registration.pushManager.subscribe = options => {
    if (!gesture) throw new DOMException("Gesture expired", "NotAllowedError");
    return subscribe(options);
  };
  globalThis.Notification.requestPermission = () => { gesture = false; throw new Error("Separate permission consumes WebKit activation"); };
  const operation = browser.connectPush(owner, snapshot(), prepared);
  gesture = false;
  assert.deepEqual(fake.calls, [["subscribe", true, 65]], "subscribe runs before the caller leaves the gesture stack");
  const result = await operation;
  assert.equal(result.subscription.subscribed, true); assert.equal(browser.rememberedNotificationOwner(), owner);
  assert.deepEqual(fake.calls.find(call => Array.isArray(call) && call[0] === "subscribe"), ["subscribe", true, 65]);
  const api = fake.calls.find(call => Array.isArray(call) && call[0] === "api")[1];
  assert.equal(api.expectedOwnerPublicId, owner); assert.equal(api.subscription.endpoint, "https://fcm.googleapis.com/delivery");
});

test("declined permission never creates or sends a browser subscription", async () => {
  const fake = fakeBrowser({ permission: "default" });
  const prepared = await browser.preparePushConnection(owner); fake.calls.length = 0;
  await assert.rejects(browser.connectPush(owner, snapshot(), prepared), /не разрешил подписку/);
  assert.deepEqual(fake.calls, [["subscribe", true, 65]]);
});

test("failed server binding preserves the shared browser endpoint without claiming enabled and supports retry", async () => {
  const fake = fakeBrowser();
  globalThis.fetch = async (_url, options) => options.method === "GET" ? Response.json(snapshot()) : Response.json({ code: "PUSH_NOT_CONFIGURED", message: "Нет доставки" }, { status: 503 });
  const prepared = await browser.preparePushConnection(owner);
  await assert.rejects(browser.connectPush(owner, snapshot(), prepared), /Нет доставки/);
  assert.equal(browser.rememberedNotificationOwner(), null); assert.equal(fake.calls.includes("unsubscribe"), false);
  assert.ok(await fake.registration.pushManager.getSubscription());
  globalThis.fetch = async () => Response.json(snapshot({ subscription: { subscribed: true } }));
  const retry = await browser.preparePushConnection(owner);
  assert.equal((await browser.connectPush(owner, snapshot(), retry)).subscription.subscribed, true);
  assert.equal(fake.calls.filter(call => Array.isArray(call) && call[0] === "subscribe").length, 1, "retry binds the existing subscription");
});

test("account switch clears previous local subscription without subscribing the new account", async () => {
  const fake = fakeBrowser(); await browser.connectPush(owner, snapshot(), await browser.preparePushConnection(owner)); fake.calls.length = 0;
  await browser.clearPreviousNotificationOwner(owner); assert.deepEqual(fake.calls, []);
  browser.setActiveNotificationOwner("BBBB-0000-0002");
  await browser.clearPreviousNotificationOwner("BBBB-0000-0002");
  assert.deepEqual(fake.calls, ["registration", "unsubscribe"]); assert.equal(browser.rememberedNotificationOwner(), null);
});


test("account switch while native subscribe permission is open cannot bind or clean up another owner", async () => {
  const fake = fakeBrowser(); let permit;
  const prepared = await browser.preparePushConnection(owner); fake.calls.length = 0;
  fake.registration.pushManager.subscribe = () => new Promise(resolve => { permit = () => resolve(fake.make()); });
  const connecting = browser.connectPush(owner, snapshot(), prepared);
  browser.setActiveNotificationOwner("BBBB-0000-0002");
  browser.rememberNotificationOwner("BBBB-0000-0002");
  permit();
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
  const old = browser.connectPush(owner, snapshot(), await browser.preparePushConnection(owner));
  while (!finishOld) await new Promise(resolve => setImmediate(resolve));
  const nextOwner = "BBBB-0000-0002";
  browser.setActiveNotificationOwner(nextOwner);
  browser.rememberNotificationOwner(nextOwner);
  const nextPreparation = browser.preparePushConnection(nextOwner);
  finishOld();
  await assert.rejects(old, /Профиль изменился/);
  const result = await browser.connectPush(nextOwner, snapshot({ ownerPublicId: nextOwner }), await nextPreparation);
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
  await browser.connectPush(owner, snapshot(), await browser.preparePushConnection(owner)); fake.calls.length = 0;
  const prepared = await browser.preparePushConnection(owner); fake.calls.length = 0;
  // Another tab owns the browser subscription; this tab has not learned about its changed cookie.
  browser.rememberNotificationOwner("BBBB-0000-0002");
  globalThis.fetch = async () => Response.json({ code: "NOTIFICATION_OWNER_MISMATCH", message: "Профиль изменился" }, { status: 409 });
  await assert.rejects(browser.connectPush(owner, snapshot(), prepared), /другой вкладке/);
  await assert.rejects(browser.preparePushConnection(owner), /Профиль изменился/);
  assert.deepEqual(fake.calls, []);
  assert.equal(browser.rememberedNotificationOwner(), "BBBB-0000-0002");
});

test("denied permission is explained locally and never reaches server binding", async () => {
  const fake = fakeBrowser({ permission: "denied" });
  const prepared = await browser.preparePushConnection(owner); fake.calls.length = 0;
  await assert.rejects(browser.connectPush(owner, snapshot(), prepared), /запрещены.*настройках устройства/);
  assert.equal(fake.calls.some(call => Array.isArray(call) && call[0] === "api"), false);
  assert.equal(browser.rememberedNotificationOwner(), null);
  assert.equal(browser.notificationSupport().supported, false);
});

test("preparation never removes a foreign subscription; explicit cleanup requires a second gesture", async () => {
  const fake = fakeBrowser();
  await browser.connectPush(owner, snapshot(), await browser.preparePushConnection(owner));
  browser.rememberNotificationOwner("BBBB-0000-0002"); fake.calls.length = 0;
  const prepared = await browser.preparePushConnection(owner);
  assert.deepEqual(fake.calls, ["registration"]);
  assert.ok(prepared.subscription, "opening settings preserves the existing browser subscription");
  await assert.rejects(browser.connectPush(owner, snapshot(), prepared), /Старая подписка отключена/);
  assert.deepEqual(fake.calls, ["registration", "unsubscribe"], "the cleanup click never subscribes after an await");
  assert.equal(browser.rememberedNotificationOwner(), null);
  const result = await browser.connectPush(owner, snapshot(), await browser.preparePushConnection(owner));
  assert.equal(result.subscription.subscribed, true);
});

test("a changed authentication cookie blocks destructive cleanup even with a prepared foreign subscription", async () => {
  const fake = fakeBrowser();
  await browser.connectPush(owner, snapshot(), await browser.preparePushConnection(owner));
  browser.rememberNotificationOwner("BBBB-0000-0002");
  const prepared = await browser.preparePushConnection(owner); fake.calls.length = 0;
  globalThis.fetch = async () => Response.json({ code: "NOTIFICATION_OWNER_MISMATCH", message: "Профиль изменился" }, { status: 409 });
  await assert.rejects(browser.connectPush(owner, snapshot(), prepared), /Профиль изменился/);
  assert.deepEqual(fake.calls, []);
  assert.equal(browser.rememberedNotificationOwner(), "BBBB-0000-0002");
});

test("permission granted without a server-confirmed subscription remains disconnected", async () => {
  const fake = fakeBrowser();
  globalThis.fetch = async () => Response.json(snapshot({ subscription: { subscribed: false } }));
  const prepared = await browser.preparePushConnection(owner);
  await assert.rejects(browser.connectPush(owner, snapshot(), prepared), /Сервер не подтвердил/);
  assert.equal(globalThis.Notification.permission, "granted");
  assert.equal(browser.rememberedNotificationOwner(), null);
  assert.equal(fake.calls.includes("unsubscribe"), false, "a false server confirmation cannot revoke a shared browser endpoint");
});

test("server authentication is revalidated after browser subscription without destroying another tab's endpoint", async () => {
  const fake = fakeBrowser();
  const prepared = await browser.preparePushConnection(owner); fake.calls.length = 0;
  globalThis.fetch = async () => Response.json({ code: "NOTIFICATION_OWNER_MISMATCH", message: "Профиль изменился" }, { status: 409 });
  await assert.rejects(browser.connectPush(owner, snapshot(), prepared), /Профиль изменился/);
  assert.deepEqual(fake.calls, [["subscribe", true, 65]], "a stale auth cookie permits neither bind nor cleanup");
  assert.equal(browser.rememberedNotificationOwner(), null);
});

test("same-tab mutation lock rejects a new gesture instead of queuing subscribe after activation expires", async () => {
  const fake = fakeBrowser();
  const prepared = await browser.preparePushConnection(owner); fake.calls.length = 0;
  let release;
  globalThis.fetch = () => new Promise(resolve => { release = () => resolve(Response.json(snapshot())); });
  const preparing = browser.preparePushConnection(owner);
  await assert.rejects(browser.connectPush(owner, snapshot(), prepared), /ещё обновляется/);
  release(); await preparing;
  assert.deepEqual(fake.calls, ["registration"]);
});

test("expired or reused preparation cannot prompt or bind", async t => {
  const fake = fakeBrowser();
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  const expired = await browser.preparePushConnection(owner); fake.calls.length = 0;
  t.mock.timers.tick(5 * 60_000 + 1);
  await assert.rejects(browser.connectPush(owner, snapshot(), expired), /устарела/);
  assert.deepEqual(fake.calls, []);
  const fresh = await browser.preparePushConnection(owner);
  await browser.connectPush(owner, snapshot(), fresh); fake.calls.length = 0;
  await assert.rejects(browser.connectPush(owner, snapshot(), fresh), /устарела/);
  assert.deepEqual(fake.calls, []);
});

test("slow native subscribe times out, consumes late completion and never binds after a profile change", async t => {
  const fake = fakeBrowser();
  const prepared = await browser.preparePushConnection(owner); fake.calls.length = 0;
  let finish;
  fake.registration.pushManager.subscribe = () => new Promise(resolve => { finish = () => resolve(fake.make()); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const connection = browser.connectPush(owner, snapshot(), prepared);
  const rejected = assert.rejects(connection, /долго создаёт подписку/);
  t.mock.timers.tick(30_000); await rejected;
  const retry = await browser.preparePushConnection(owner);
  await assert.rejects(browser.connectPush(owner, snapshot(), retry), /ещё завершает подписку/);
  browser.setActiveNotificationOwner("BBBB-0000-0002"); browser.rememberNotificationOwner("BBBB-0000-0002");
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fake.calls, ["registration"], "late native completion cannot post, remember or unsubscribe");
  assert.equal(browser.rememberedNotificationOwner(), "BBBB-0000-0002");
});

test("service worker lookup has an actionable timeout and late rejection is consumed", async t => {
  const fake = fakeBrowser(); let rejectRegistration;
  globalThis.navigator.serviceWorker.getRegistration = () => new Promise((_resolve, reject) => { rejectRegistration = reject; });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const preparing = browser.preparePushConnection(owner);
  const rejected = assert.rejects(preparing, /долго готовит уведомления/);
  while (!rejectRegistration) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10_000); await rejected;
  rejectRegistration(new DOMException("Native worker failed later", "InvalidStateError"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fake.calls, []); assert.equal(browser.rememberedNotificationOwner(), null);
});

test("aborted preparation is read-only and cannot become an available connection later", async () => {
  const fake = fakeBrowser(); const controller = new AbortController(); let finish;
  globalThis.navigator.serviceWorker.getRegistration = () => new Promise(resolve => { finish = () => resolve(fake.registration); });
  const preparing = browser.preparePushConnection(owner, controller.signal);
  const rejected = assert.rejects(preparing, { name: "AbortError" });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  controller.abort(); await rejected; finish(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fake.calls, []);
});

test("preparation repairs a missing or failed worker without asking permission or touching subscriptions", async () => {
  for (const empty of [undefined, { active: null, installing: null, waiting: null }]) {
    const fake = fakeBrowser();
    let current = empty, finish;
    navigator.serviceWorker.getRegistration = async () => current;
    navigator.serviceWorker.register = async (url, options) => {
      fake.calls.push(["register", url, options]);
      current = { ...fake.registration, active: null, installing: {} };
      return current;
    };
    navigator.serviceWorker.ready = new Promise(resolve => {
      finish = () => { current.active = {}; current.installing = null; resolve(current); };
    });
    const preparing = browser.preparePushConnection(owner);
    while (!fake.calls.length) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(fake.calls, [["register", "/sw.js", { scope: "/", updateViaCache: "none" }]]);
    finish();
    const prepared = await preparing;
    assert.equal(prepared.subscription, null);
    assert.equal(browser.rememberedNotificationOwner(), null);
    assert.equal(fake.calls.length, 1, "worker recovery never prompts, subscribes or unsubscribes");
    const connected = await browser.connectPush(owner, snapshot(), prepared);
    assert.equal(connected.subscription.subscribed, true);
  }
});

test("failed worker registration explains retry and a subsequent attempt can recover", async () => {
  const fake = fakeBrowser();
  navigator.serviceWorker.getRegistration = async () => undefined;
  navigator.serviceWorker.register = async () => { throw new TypeError("Worker script fetch failed"); };
  await assert.rejects(browser.preparePushConnection(owner), /Не удалось подготовить уведомления.*Повторить проверку/);
  assert.deepEqual(fake.calls, []);
  navigator.serviceWorker.register = async () => fake.registration;
  const prepared = await browser.preparePushConnection(owner);
  assert.equal(prepared.subscription, null);
  assert.deepEqual(fake.calls, []);
});

test("worker recovery has a bounded activation wait and cannot bind after a late activation", async t => {
  const fake = fakeBrowser(); let finish, started = false;
  navigator.serviceWorker.getRegistration = async () => undefined;
  navigator.serviceWorker.register = async () => { started = true; return { active: null, installing: {} }; };
  navigator.serviceWorker.ready = new Promise(resolve => { finish = () => resolve(fake.registration); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const preparing = browser.preparePushConnection(owner);
  const rejected = assert.rejects(preparing, /Подготовка уведомлений затянулась/);
  while (!started) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10_000);
  await rejected;
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fake.calls, []);
  assert.equal(browser.rememberedNotificationOwner(), null);
});

test("Yandex support uses capabilities while denial help follows Android and desktop settings", () => {
  fakeBrowser();
  globalThis.navigator.userAgent = "Mozilla/5.0 (Linux; Android 14) YaBrowser/26.1";
  assert.equal(browser.notificationSupport().supported, true);
  globalThis.Notification.permission = "denied";
  assert.match(browser.notificationSupport().reason, /Настройки → Уведомления → Уведомления от сайтов/);
  globalThis.navigator.userAgent = "Mozilla/5.0 (Windows NT 10.0) YaBrowser/26.1";
  assert.match(browser.notificationSupport().reason, /Настройки → Сайты → Уведомления/);
  fakeBrowser({ ios: true, installed: false });
  globalThis.navigator.userAgent = "Mozilla/5.0 (iPhone) YaBrowser/26.1";
  assert.equal(browser.notificationSupport().supported, false);
  assert.match(browser.notificationSupport().reason, /Safari.*Поделиться.*Домой/);
  fakeBrowser({ ios: true, installed: true });
  assert.equal(browser.notificationSupport().supported, true);
});

test("preparation waits for an installing service worker and re-reads its active registration", async () => {
  const fake = fakeBrowser(); let ready;
  fake.registration.active = null; fake.registration.installing = {};
  globalThis.navigator.serviceWorker.ready = new Promise(resolve => { ready = resolve; });
  const preparing = browser.preparePushConnection(owner);
  while (!fake.calls.includes("registration")) await new Promise(resolve => setImmediate(resolve));
  fake.registration.active = {}; fake.registration.installing = null; ready(fake.registration);
  const prepared = await preparing;
  assert.equal(prepared.snapshot.ownerPublicId, owner);
  assert.deepEqual(fake.calls, ["registration", "registration"]);
});

test("a same-owner subscription replaced in another tab cannot bind the stale prepared endpoint", async () => {
  const fake = fakeBrowser();
  await browser.connectPush(owner, snapshot(), await browser.preparePushConnection(owner));
  const prepared = await browser.preparePushConnection(owner); fake.calls.length = 0;
  fake.registration.pushManager.getSubscription = async () => ({ ...fake.make(), endpoint: "https://fcm.googleapis.com/replaced" });
  await assert.rejects(browser.connectPush(owner, snapshot(), prepared), /Подписка устройства изменилась/);
  assert.deepEqual(fake.calls, []);
  assert.equal(browser.rememberedNotificationOwner(), owner);
});

test("native unsubscribe timeouts release the local lock without a late remembered-owner mutation", async t => {
  for (const action of ["clear", "disconnect"]) {
    const fake = fakeBrowser();
    await browser.connectPush(owner, snapshot(), await browser.preparePushConnection(owner));
    const subscription = await fake.registration.pushManager.getSubscription();
    let finish;
    subscription.unsubscribe = () => new Promise(resolve => { finish = () => resolve(true); });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let operation;
    if (action === "clear") {
      browser.setActiveNotificationOwner("BBBB-0000-0002");
      operation = browser.clearPreviousNotificationOwner("BBBB-0000-0002");
    } else operation = browser.disconnectPush(owner);
    const rejected = assert.rejects(operation, /долго отключает/);
    while (!finish) await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(10_000); await rejected;
    browser.setActiveNotificationOwner(owner);
    assert.ok(await browser.preparePushConnection(owner), "the timed-out native call no longer holds the local operation queue");
    finish(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(browser.rememberedNotificationOwner(), owner, action);
    t.mock.timers.reset();
  }
});

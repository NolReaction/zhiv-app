import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createNativeRemotePush } = await vite.ssrLoadModule("/features/notifications/native-remote-push.ts");
const { defaultNotificationPreferences } = await vite.ssrLoadModule("/features/notifications/notification-contract.ts");
const { queueNativeNotificationLink, takeNativeNotificationLink } = await vite.ssrLoadModule("/features/notifications/native-notifications.ts");
const owner = "AAAA-0000-0001", other = "BBBB-0000-0002";
const user = "11111111-1111-4111-8111-111111111111", otherUser = "22222222-2222-4222-8222-222222222222";
const token = "a".repeat(64), eventId = "33333333-3333-4333-8333-333333333333";
const member = (userId = user, generation = 1) => ({ authenticated: true, userId, generation, expiresAt: "2027-01-01T00:00:00Z" });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(saved = null) {
  let storage = saved, subscribed = false;
  const calls = [];
  const snapshot = (id, platform = "ios") => ({ ownerPublicId: id, preferences: defaultNotificationPreferences("UTC"), delivery: { platform, configured: true, reason: null, categories: ["mail", "checkin"] }, subscription: { subscribed } });
  const port = {
    read: async () => storage, write: async value => { storage = value; calls.push(["write", value]); },
    configuration: async () => ({ platform: "ios", configured: true, reason: null }),
    permission: async () => "granted", requestPermission: async () => { calls.push(["permission"]); return "granted"; },
    register: async () => { calls.push(["register"]); return token; },
    stop: async fence => { calls.push(["stop", fence]); },
    activate: async (...args) => { calls.push(["activate", ...args]); },
    getSettings: async (id, platform) => snapshot(id, platform),
    subscribe: async (id, platform, value) => { calls.push(["subscribe", id, platform, value]); subscribed = true; return snapshot(id, platform); },
    unsubscribe: async (id, platform) => { calls.push(["unsubscribe", id, platform]); subscribed = false; return snapshot(id, platform); },
  };
  return { port, service: createNativeRemotePush(port), calls, snapshot, get saved() { return storage; } };
}
async function ready(f) { await f.service.setSession(member()); await f.service.setOwner(owner); }

test("native remote push has separate explicit consent even when OS permission is granted", async () => {
  const f = fixture(); await ready(f);
  assert.equal(f.calls.some(([kind]) => kind === "register" || kind === "permission"), false);
  await f.service.enable(owner);
  assert.equal(f.service.getSnapshot().connected, true);
  assert.equal(f.calls.filter(([kind]) => kind === "permission").length, 1);
  const stored = JSON.parse(f.saved); assert.deepEqual(stored, { version: 1, userId: user, ownerPublicId: owner, enabled: true });
  assert.equal(f.saved.includes(token), false);
});
test("unconfigured builds show unavailable and never attempt provider registration", async () => {
  const f = fixture(); f.port.configuration = async () => ({ platform: "ios", configured: false, reason: "Unavailable" });
  await ready(f); await assert.rejects(f.service.enable(owner));
  assert.equal(f.service.getSnapshot().configured, false);
  assert.equal(f.calls.some(([kind]) => kind === "register" || kind === "permission"), false);
});
test("a failed server readiness request never enables the permission button", async () => {
  const f = fixture(); f.port.getSettings = async () => { throw new Error("offline"); };
  await f.service.setSession(member()); await assert.rejects(f.service.setOwner(owner), /offline/);
  assert.equal(f.service.getSnapshot().configured, false); await assert.rejects(f.service.enable(owner));
  assert.equal(f.calls.some(([kind]) => kind === "permission" || kind === "register"), false);
});
test("server disable cannot leave a previously connected device labelled active", async () => {
  const f = fixture(); await ready(f); await f.service.enable(owner);
  f.port.getSettings = async (id, platform) => { const value = f.snapshot(id, platform); value.delivery.configured = false; return value; };
  await f.service.refresh(); assert.equal(f.service.getSnapshot().connected, false); assert.equal(f.service.getSnapshot().configured, false);
  assert.equal(f.calls.at(-1)[0], "stop");
});
test("cold launch restores same-owner consent with fresh token registration and no permission prompt", async () => {
  const first = fixture(); await ready(first); await first.service.enable(owner);
  const f = fixture(first.saved); await ready(f);
  assert.equal(f.service.getSnapshot().connected, true);
  assert.equal(f.calls.some(([kind]) => kind === "permission"), false);
  assert.equal(f.calls.filter(([kind]) => kind === "register").length, 1);
});
test("failed consent write never registers the provider or enables UI", async () => {
  const f = fixture(); await ready(f); f.port.write = async () => { throw new Error("disk full"); };
  await assert.rejects(f.service.enable(owner), /disk full/);
  assert.equal(f.service.getSnapshot().enabled, false); assert.equal(f.service.getSnapshot().connected, false);
  assert.equal(f.calls.some(([kind]) => kind === "register"), false);
});
test("account switch during permission prompt cannot register the previous account", async () => {
  const f = fixture(); await ready(f); const permission = deferred(); f.port.requestPermission = () => permission.promise;
  const enabling = f.service.enable(owner); const rejected = assert.rejects(enabling, /Профиль изменился/);
  const switching = f.service.setSession(member(otherUser, 2)); permission.resolve("granted");
  await rejected; await switching; await f.service.setOwner(other);
  assert.equal(f.service.getSnapshot().ownerPublicId, other); assert.equal(f.service.getSnapshot().enabled, false);
  assert.equal(f.calls.some(([kind]) => kind === "register"), false);
});
test("late subscription acknowledgement after disable never reconnects; offline disable stops native immediately", async () => {
  const f = fixture(); await ready(f); const response = deferred(), arrived = deferred();
  f.port.subscribe = async () => { arrived.resolve(); return response.promise; };
  const enabling = f.service.enable(owner); const rejected = assert.rejects(enabling, /Профиль изменился/); await arrived.promise;
  const before = f.calls.length; const disabling = f.service.disable(owner);
  assert.equal(f.calls[before][0], "stop"); assert.equal(f.service.getSnapshot().connected, false);
  response.resolve({ ...f.snapshot(owner), subscription: { subscribed: true } });
  await rejected; await disabling; assert.equal(f.service.getSnapshot().enabled, false); assert.equal(f.service.getSnapshot().connected, false);
});
test("offline disable persists intent and retries server revocation after network restoration", async () => {
  const f = fixture(); await ready(f); await f.service.enable(owner);
  const revoke = f.port.unsubscribe; f.port.unsubscribe = async () => { throw new Error("offline"); };
  await assert.rejects(f.service.disable(owner), /offline/);
  assert.equal(JSON.parse(f.saved).enabled, false); assert.equal(f.service.getSnapshot().connected, false);
  f.port.unsubscribe = revoke; await f.service.refresh();
  assert.equal(f.calls.some(([kind]) => kind === "unsubscribe"), true);
  assert.equal(f.calls.filter(([kind]) => kind === "register").length, 1);
});
test("new native generation for the same UUID prevents stale activation and ignores older session events", async () => {
  const f = fixture(); await ready(f); const registration = deferred(), arrived = deferred();
  f.port.register = async () => { arrived.resolve(); return registration.promise; };
  const enabling = f.service.enable(owner); const rejected = assert.rejects(enabling, /Профиль изменился/); await arrived.promise;
  const switching = f.service.setSession(member(user, 2)); await f.service.setSession(member(user, 1));
  registration.resolve(token); await rejected; await switching;
  const activations = f.calls.filter(([kind]) => kind === "activate");
  assert.equal(activations.length, 1); assert.equal(activations[0][3], 2);
});
test("provider token refresh is owner-fenced and never prompts or persists the new token", async () => {
  const f = fixture(); await ready(f); await f.service.enable(owner); const rotated = "b".repeat(64);
  await f.service.tokenChanged(rotated);
  assert.equal(f.calls.at(-1)[3], rotated); assert.equal(f.saved.includes(rotated), false);
  assert.equal(f.calls.filter(([kind]) => kind === "permission").length, 1);
  await f.service.setSession({ authenticated: false, generation: 2 }); const count = f.calls.length;
  await f.service.tokenChanged(rotated); assert.equal(f.calls.length, count);
});
test("dispose invalidates a pending registration without a late subscription", async () => {
  const f = fixture(); await ready(f); const registration = deferred(), arrived = deferred();
  f.port.register = async () => { arrived.resolve(); return registration.promise; };
  const enabling = f.service.enable(owner); const rejected = assert.rejects(enabling, /Профиль изменился/); await arrived.promise;
  f.service.dispose(); registration.resolve(token); await rejected;
  assert.equal(f.calls.some(([kind]) => kind === "subscribe"), false);
});
test("denied system permission revokes delivery without requesting permission on foreground refresh", async () => {
  const f = fixture(); await ready(f); await f.service.enable(owner); f.port.permission = async () => "denied";
  await f.service.refresh(); assert.equal(f.service.getSnapshot().connected, false);
  assert.equal(f.calls.at(-1)[0], "unsubscribe"); assert.equal(f.calls.filter(([kind]) => kind === "permission").length, 1);
});
test("remote taps accept only safe account-scoped destinations and valid event identifiers", () => {
  const payload = { source: "mochlik-remote", ownerPublicId: owner, target: "mailbox", eventId };
  queueNativeNotificationLink(payload); assert.deepEqual(takeNativeNotificationLink(), { ownerPublicId: owner, target: "mailbox" });
  queueNativeNotificationLink(payload); assert.equal(takeNativeNotificationLink(), null, "cold-launch and delegate callbacks are deduplicated");
  for (const invalid of [{ ...payload, target: "https://evil.test" }, { ...payload, eventId: "x" }, { ...payload, target: "construction" }, { ...payload, source: "other" }]) {
    queueNativeNotificationLink(invalid); assert.equal(takeNativeNotificationLink(), null);
  }
});
test("Android owns the only FCM receiver and iOS personal-team builds do not enable APNs by default", async () => {
  const read = file => readFile(new URL(file, `file://${root}/`), "utf8");
  const manifest = await read("apps/mobile/android/app/src/main/AndroidManifest.xml");
  assert.match(manifest, /com\.capacitorjs\.plugins\.pushnotifications\.MessagingService[^>]+tools:node="remove"/);
  assert.match(manifest, /android:name="\.MochlikMessagingService"/);
  assert.match(manifest, /firebase_messaging_auto_init_enabled" android:value="false"/);
  const entitlements = await read("apps/mobile/ios/App/App/App.entitlements"); assert.doesNotMatch(entitlements, /aps-environment/);
  const project = await read("apps/mobile/ios/App/App.xcodeproj/project.pbxproj");
  assert.equal((project.match(/MOCHLIK_PUSH_ENABLED = NO/g) ?? []).length, 2);
});

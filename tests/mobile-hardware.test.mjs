import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { planNativeGameReminders: plan } = await vite.ssrLoadModule("/features/notifications/native-notification-plan.ts");
const { createNativeNotifications } = await vite.ssrLoadModule("/features/notifications/native-notifications.ts");
const { defaultNotificationPreferences } = await vite.ssrLoadModule("/features/notifications/notification-contract.ts");
const device = await vite.ssrLoadModule("/lib/device-runtime.ts");
const owner = "AAAA-0000-0001", other = "BBBB-0000-0002";
const now = Date.parse("2026-11-13T12:00:00Z");
const prefs = (changes = {}) => ({ ...defaultNotificationPreferences("UTC"), ...changes });
const job = (id = "job-a", changes = {}) => ({ id, kind: "construction", targetId: "home", finishesAt: new Date(now + 3600_000).toISOString(), ...changes });
const game = (jobs, ownerPublicId = owner) => ({ ownerPublicId, jobs });
const settings = (preferences = prefs(), ownerPublicId = owner) => ({ ownerPublicId, preferences, delivery: { configured: false, publicKey: null, reason: null }, subscription: { subscribed: false } });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(saved = null) {
  let storage = saved, clock = now, scheduled = [];
  const calls = [];
  const port = { read: async () => storage, write: async value => { storage = value; }, checkPermission: async () => "granted", requestPermission: async () => "granted",
    pending: async () => scheduled, cancel: async ids => { calls.push(["cancel", ids]); scheduled = scheduled.filter(item => !ids.includes(item.id)); },
    clearDelivered: async () => { calls.push(["clearDelivered"]); },
    schedule: async values => { calls.push(["schedule", values]); scheduled = [...values]; }, now: () => clock };
  return { port, service: createNativeNotifications(port), calls, get scheduled() { return scheduled; }, get saved() { return storage; }, setNow: value => { clock = value; } };
}
async function configured(f) { await f.service.setOwner(owner); await f.service.setPreferences(settings()); await f.service.setGame(owner, game([job()]), now); }

test("reminders use server offset, exclude finished/garden jobs, and obey topic choices", () => {
  const value = plan(game([job(), job("past", { finishesAt: new Date(now - 1000).toISOString() }), job("garden", { kind: "production", targetId: "garden" })]), prefs(), now, now + 900_000);
  assert.equal(value.length, 1); assert.equal(value[0].at, now + 4500_000); assert.equal(value[0].extra.ownerPublicId, owner);
  assert.equal(plan(game([job()]), prefs({ constructionCompleted: false }), now, now).length, 0);
});
test("quiet hours defer reminders in the selected timezone across DST", () => {
  const utcNow = Date.parse("2026-10-24T20:00:00Z"), finish = "2026-10-25T00:30:00Z";
  const values = plan(game([job("dst", { finishesAt: finish })]), prefs({ timeZone: "Europe/Berlin", quietStart: "23:00", quietEnd: "07:00" }), utcNow, utcNow);
  assert.equal(new Date(values[0].at).toISOString(), "2026-10-25T06:00:00.000Z");
});
test("daily and interval limits include prior delivered schedule records", () => {
  const preferences = prefs({ rateLimitsEnabled: true, maxPerDay: 2, minIntervalMinutes: 120 });
  const values = plan(game([job(), job("two", { finishesAt: new Date(now + 7200_000).toISOString() }), job("three", { finishesAt: new Date(now + 10800_000).toISOString() })]), preferences, now, now, [now - 3600_000]);
  assert.equal(values.length, 1); assert.equal(values[0].at, now + 3600_000);
});
test("local reminders require an explicit device opt-in, even with granted OS permission", async () => {
  const f = fixture(); await configured(f); assert.equal(f.scheduled.length, 0);
  await f.service.enable(owner); assert.equal(f.scheduled.length, 1); assert.equal((await f.service.status(owner)).enabled, true);
  await f.service.setGame(owner, game([]), now); assert.equal(f.scheduled.length, 0);
});
test("account switch cancels old reminders and cannot reuse the previous owner's consent", async () => {
  const f = fixture(); await configured(f); await f.service.enable(owner);
  await f.service.setOwner(other); assert.equal(f.scheduled.length, 0);
  await f.service.setPreferences(settings(prefs(), other)); await f.service.setGame(other, game([job()], other), now);
  assert.equal((await f.service.status(other)).enabled, false); assert.equal(f.scheduled.length, 0);
  await assert.rejects(f.service.enable(owner), /Профиль изменился/);
});
test("late permission response after logout cannot enable or schedule old account", async () => {
  const f = fixture(); await configured(f); const permission = deferred(); f.port.requestPermission = () => permission.promise;
  const enabling = f.service.enable(owner); await f.service.reset(); permission.resolve("granted");
  await assert.rejects(enabling, /Профиль изменился/); assert.equal(f.scheduled.length, 0);
});
test("late native scheduling is cleared before logout finishes", async () => {
  const f = fixture(); await configured(f); const scheduling = deferred(), reached = deferred();
  const original = f.port.schedule;
  f.port.schedule = async values => { reached.resolve(); await scheduling.promise; await original(values); };
  const enabling = f.service.enable(owner); await reached.promise;
  const logout = f.service.reset(); scheduling.resolve(); await enabling; await logout;
  assert.equal(f.scheduled.length, 0); assert.equal((await f.service.status(owner)).enabled, false);
});
test("write failure never leaves enabled in-memory consent", async () => {
  const f = fixture(); await configured(f); f.port.write = async () => { throw new Error("disk full"); };
  await assert.rejects(f.service.enable(owner), /disk full/);
  assert.equal((await f.service.status(owner)).enabled, false); assert.equal(f.scheduled.length, 0);
});
test("a cold launch restores consent for the same owner without a new permission prompt", async () => {
  const first = fixture(); await configured(first); await first.service.enable(owner);
  const second = fixture(first.saved); second.port.requestPermission = async () => { throw new Error("must not prompt"); };
  await configured(second); assert.equal(second.scheduled.length, 1); assert.equal((await second.service.status(owner)).enabled, true);
});
test("native activity and network independently override browser guesses without changing browser globals", () => {
  device.resetDeviceEnvironment(); const page = { hidden: false }; let changes = 0;
  const unsubscribe = device.subscribeDeviceEnvironment(() => { changes++; });
  device.updateDeviceEnvironment({ active: false, connected: false }); assert.equal(device.deviceIsActive(page), false); assert.equal(device.deviceIsOnline(), false);
  device.updateDeviceEnvironment({ active: true }); assert.equal(device.deviceIsActive(page), true); assert.equal(device.deviceIsOnline(), false);
  page.hidden = true; assert.equal(device.deviceIsActive(page), false); assert.equal(changes, 2);
  unsubscribe(); device.resetDeviceEnvironment();
});

test("unreadable consent fails closed and logout still cancels native scheduled reminders", async () => {
  const f = fixture(); f.port.read = async () => { throw new Error("storage unavailable"); };
  await f.port.schedule([{ id: 17, extra: { source: "mochlik-game" } }]);
  await f.service.reset(); assert.equal(f.scheduled.length, 0); assert.equal((await f.service.status(owner)).enabled, false);
});
test("native memory pressure releases inactive decoded audio without disposing active buffers", async () => {
  const { createAudioAssetCache } = await vite.ssrLoadModule("/features/audio/runtime/audio-asset-cache.ts");
  const inUse = new Set(["playing"]); let requests = 0;
  const cache = createAudioAssetCache({ context: () => ({ state: "running", decodeAudioData: async () => ({ length: 100, numberOfChannels: 1 }) }),
    now: () => 0, changed() {}, isInUse: id => inUse.has(id), fetchAsset: async () => { requests++; return new Response(new Uint8Array([1])); } });
  const asset = id => ({ id, status: "ready", src: `/audio/${id}.wav` });
  const playing = await cache.load(asset("playing")); await cache.load(asset("unused"));
  cache.trimUnused(); assert.equal(cache.loadedCount(), 1); assert.equal(await cache.load(asset("playing")), playing); assert.equal(requests, 2);
  await cache.load(asset("unused")); assert.equal(requests, 3); cache.dispose();
});
test("native pause and memory events reach audio lifecycle then detach completely", async () => {
  const { attachAudioLifecycle } = await vite.ssrLoadModule("/features/audio/ui/audio-lifecycle.ts");
  device.resetDeviceEnvironment(); const page = new EventTarget(); page.hidden = false; const surface = new EventTarget(); const states = []; let trims = 0;
  const cleanup = attachAudioLifecycle({ setVisible: value => states.push(value), trimMemory: () => { trims++; } }, page, surface);
  device.updateDeviceEnvironment({ active: false }); device.reportMemoryPressure();
  assert.deepEqual(states, [true, false]); assert.equal(trims, 1);
  cleanup(); const afterCleanup = [...states]; device.updateDeviceEnvironment({ active: true }); device.reportMemoryPressure();
  assert.deepEqual(states, afterCleanup); assert.equal(trims, 1); device.resetDeviceEnvironment();
});

test("cold offline launch preserves known pending reminders until a fresh game snapshot can replace them", async () => {
  const first = fixture(); await configured(first); await first.service.enable(owner);
  const second = fixture(first.saved); await second.port.schedule(first.scheduled);
  await second.service.setOwner(owner); await second.service.reconcile();
  assert.equal(second.scheduled.length, 1);
  await second.service.setPreferences(settings()); assert.equal(second.scheduled.length, 1);
  await second.service.setGame(owner, game([]), now); assert.equal(second.scheduled.length, 0);
});

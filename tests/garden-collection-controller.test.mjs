import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createGardenCollectionController, economyGardenCrop, berryCollectionStatus } = await vite.ssrLoadModule("/features/economy/garden-collection.ts");
const now = Date.UTC(2026, 9, 4), owner = "ABCD-EFGH-JKMP";
const job = (id = "crop") => ({ id, kind: "production", targetId: "garden", recipeId: "grow_berries",
  startedAt: new Date(now - 600000).toISOString(), finishesAt: new Date(now).toISOString(), rewards: { berries: 6 },
  collection: { kind: "berry_harvest", seconds: 8, startedAt: null, finishesAt: null } });
const collecting = (id = "crop") => ({ ...job(id), collection: { kind: "berry_harvest", seconds: 8,
  startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 8000).toISOString() } });
const snapshot = (jobs = [job()]) => ({ ownerPublicId: owner, revision: 1, jobs, inventory: {}, storage: { available: 200 } });
function harness(initial = {}, boundOwner = owner) {
  const controller = createGardenCollectionController(boundOwner), sent = [];
  let input = { snapshot: snapshot(), now, busy: false, uncertain: false, retryAt: 0, error: null, sceneAvailable: true, ...initial };
  const update = patch => { input = { ...input, ...patch }; controller.update(input, (action, targetId) => sent.push({ action, targetId })); };
  update({});
  const event = (status, patch = {}) => controller.sceneEvent({ ...controller.getSnapshot().request, status, ...patch });
  function begin() {
    assert.equal(controller.start("crop"), true); update({ busy: true });
    update({ snapshot: { ...snapshot([collecting()]), revision: 2 }, busy: false });
    assert.equal(controller.getSnapshot().phase, "walking"); event("started");
    return controller.getSnapshot().request;
  }
  return { controller, sent, update, event, begin, get input() { return input; } };
}

test("normal harvest waits for both deposit and server deadline, retaining its scene request until confirmation", () => {
  const h = harness(), request = h.begin();
  assert.deepEqual(h.sent, [{ action: "start_collection", targetId: "crop" }]);
  assert.equal(h.controller.start("crop"), false);
  h.update({ now: now + 1000 }); h.event("completed");
  assert.equal(h.controller.getSnapshot().phase, "waiting");
  assert.equal(h.controller.getSnapshot().request, request);
  h.update({ now: now + 7999 }); assert.equal(h.sent.length, 1);
  h.update({ now: now + 8000 });
  assert.deepEqual(h.sent.at(-1), { action: "claim_job", targetId: "crop" });
  assert.equal(h.controller.getSnapshot().request, request);
  h.update({ busy: true });
  for (let i = 0; i < 5; i++) { h.event("completed"); h.update({ busy: true, now: now + 8000 + i }); }
  assert.equal(h.sent.length, 2);
  h.update({ snapshot: { ...snapshot([]), revision: 3, inventory: { berries: 6 } }, busy: false });
  assert.deepEqual(h.controller.getSnapshot(), { jobId: null, phase: "idle", request: null });
  assert.deepEqual(h.input.snapshot.inventory, { berries: 6 });
});

test("an acknowledged long walk never claims just because eight or fifteen seconds have passed", () => {
  const h = harness(), request = h.begin();
  h.update({ now: now + 45000 });
  assert.equal(h.controller.getSnapshot().phase, "walking"); assert.equal(h.sent.length, 1);
  h.event("completed", { requestId: request.requestId + 1 });
  h.event("completed", { jobId: "another-crop" });
  assert.equal(h.sent.length, 1);
  h.event("completed"); assert.equal(h.sent.length, 2);
});

test("failed scene loading falls back only before acknowledgement and still requires the server deadline", () => {
  const h = harness(); h.controller.start("crop");
  h.update({ snapshot: snapshot([collecting()]) });
  h.update({ now: now + 14999 }); assert.equal(h.sent.length, 1);
  h.update({ now: now + 15000 });
  assert.equal(h.controller.getSnapshot().phase, "claiming"); assert.equal(h.sent.at(-1).action, "claim_job");
  const unavailable = harness(); unavailable.begin(); unavailable.event("unavailable");
  assert.equal(unavailable.controller.getSnapshot().phase, "waiting"); assert.equal(unavailable.sent.length, 1);
  unavailable.update({ now: now + 8000 }); assert.equal(unavailable.sent.at(-1).action, "claim_job");
});

test("reload, reduced motion and hidden scenes can finish a confirmed collection without replaying a walk", () => {
  const restored = harness({ snapshot: snapshot([collecting()]), now: now + 4000 });
  assert.equal(restored.controller.getSnapshot().phase, "waiting"); assert.equal(restored.controller.getSnapshot().request, null);
  restored.update({ now: now + 8000 }); assert.equal(restored.sent.length, 1); assert.equal(restored.sent[0].action, "claim_job");
  const reduced = harness({ sceneAvailable: false }); reduced.controller.start("crop");
  reduced.update({ snapshot: snapshot([collecting()]) });
  assert.equal(reduced.controller.getSnapshot().phase, "waiting");
  reduced.update({ now: now + 8000 }); assert.equal(reduced.sent.at(-1).action, "claim_job");
  const hidden = harness(); hidden.begin(); hidden.update({ sceneAvailable: false, now: now + 9000 });
  assert.equal(hidden.sent.at(-1).action, "claim_job"); assert.equal(hidden.controller.getSnapshot().request, null);
});

test("interruption requires an explicit new request, while hiding a paused scene allows background completion", () => {
  const h = harness(), first = h.begin(); h.event("interrupted");
  assert.equal(h.controller.getSnapshot().phase, "paused"); h.update({ now: now + 9000 });
  assert.equal(h.sent.length, 1);
  assert.equal(h.controller.start("crop"), true);
  const second = h.controller.getSnapshot().request;
  assert.notEqual(second.requestId, first.requestId); assert.equal(h.sent.length, 1, "resume does not restart the server timer");
  h.controller.sceneEvent({ ...first, status: "completed" }); assert.equal(h.sent.length, 1);
  h.event("started"); h.event("interrupted"); h.update({ sceneAvailable: false });
  assert.equal(h.sent.at(-1).action, "claim_job");
});

test("uncertain replies and retry backoff prevent extra commands and preserve the completed request", () => {
  const h = harness(), request = h.begin(); h.update({ now: now + 9000 }); h.event("completed");
  h.update({ busy: true }); h.update({ busy: false, uncertain: true, error: "Ответ потерян" });
  assert.equal(h.controller.getSnapshot().phase, "claiming"); assert.equal(h.controller.getSnapshot().request, request);
  assert.equal(h.controller.start("crop"), false);
  for (let i = 0; i < 3; i++) h.update({ now: now + 10000 + i });
  assert.equal(h.sent.length, 2);
  h.update({ snapshot: { ...snapshot([]), revision: 3, inventory: { berries: 6 } }, uncertain: false, error: null });
  assert.equal(h.controller.getSnapshot().phase, "idle");
  const backoff = harness({ snapshot: snapshot([collecting()]), now: now + 9000, retryAt: now + 20000 });
  assert.equal(backoff.sent.length, 0); backoff.update({ now: now + 20000 }); assert.equal(backoff.sent.length, 1);
});

test("storage races and definitive claim errors keep a manual retry instead of repeatedly sending writes", () => {
  const full = harness({ snapshot: { ...snapshot(), storage: { available: 5 } } });
  assert.equal(full.controller.start("crop"), false); assert.equal(full.sent.length, 0);
  const h = harness(); h.begin(); h.update({ now: now + 9000, snapshot: { ...snapshot([collecting()]), storage: { available: 0 } } });
  h.event("completed"); assert.equal(h.controller.getSnapshot().phase, "claim-ready"); assert.equal(h.sent.length, 1);
  h.update({ snapshot: snapshot([collecting()]) }); assert.equal(h.sent.length, 1);
  assert.equal(h.controller.start("crop"), true); assert.equal(h.sent.at(-1).action, "claim_job");
  h.update({ busy: true }); h.update({ busy: false, error: "Склад заполнился на другом устройстве" });
  for (let i = 0; i < 5; i++) h.update({ now: now + 10000 + i });
  assert.equal(h.controller.getSnapshot().phase, "claim-ready"); assert.equal(h.sent.length, 2);
  assert.equal(h.controller.start("crop"), true); assert.equal(h.sent.length, 3);
});

test("deactivated or foreign account controllers ignore late scene events; effect replay reactivates the same request", () => {
  const h = harness(), request = h.begin(); h.controller.deactivate();
  h.controller.sceneEvent({ ...request, status: "completed" }); assert.equal(h.sent.length, 1);
  assert.equal(h.controller.start("crop"), false);
  h.update({ now: now + 9000 });
  assert.equal(h.controller.getSnapshot().request, request, "Strict Mode cleanup must not restart or discard a walk");
  h.update({ snapshot: { ...snapshot([collecting()]), ownerPublicId: "OTHER-ACCOUNT" } });
  assert.equal(h.controller.getSnapshot().phase, "idle");
  h.controller.sceneEvent({ ...request, status: "completed" }); assert.equal(h.sent.length, 1);
  assert.equal(h.controller.start("crop"), false);
  const signedOut = harness({}, null); assert.equal(signedOut.controller.start("crop"), false);
});

test("jobs claimed on another device clear the local request and old events cannot affect a new crop", () => {
  const h = harness(), old = h.begin(); h.update({ snapshot: snapshot([]) });
  assert.equal(h.controller.getSnapshot().phase, "idle");
  h.update({ snapshot: snapshot([job("new-crop")]) });
  h.controller.sceneEvent({ ...old, status: "completed" }); assert.equal(h.sent.length, 1);
  assert.equal(h.controller.start("new-crop"), true);
  h.update({ snapshot: snapshot([collecting("new-crop")]) });
  assert.notEqual(h.controller.getSnapshot().request.requestId, old.requestId);
  h.controller.sceneEvent({ ...old, status: "interrupted" }); assert.equal(h.controller.getSnapshot().phase, "walking");
});

test("recreating a controller keeps request IDs ahead of an existing account forest session", () => {
  const old = harness(), first = old.begin();
  old.controller.deactivate();
  const recreated = harness(), second = recreated.begin();
  assert.ok(second.requestId > first.requestId, "the scene's monotonic event channel accepts the new controller request");
  recreated.controller.sceneEvent({ ...first, status: "completed" });
  assert.equal(recreated.controller.getSnapshot().phase, "walking");
  assert.equal(recreated.sent.length, 1);
});

test("failed starts never launch the scene and an uncertain accepted start waits for receipt resolution", () => {
  const failed = harness(); failed.controller.start("crop"); failed.update({ busy: true });
  failed.update({ busy: false, error: "Ревизия изменилась" });
  assert.equal(failed.controller.getSnapshot().phase, "idle"); assert.equal(failed.controller.getSnapshot().request, null);
  const uncertain = harness(); uncertain.controller.start("crop"); uncertain.update({ busy: true });
  uncertain.update({ busy: false, uncertain: true, error: "Нет ответа", snapshot: snapshot([collecting()]) });
  assert.equal(uncertain.controller.getSnapshot().phase, "starting"); assert.equal(uncertain.controller.getSnapshot().request, null);
  uncertain.update({ uncertain: false, error: null });
  assert.equal(uncertain.controller.getSnapshot().phase, "walking"); assert.equal(uncertain.sent.length, 1);
});

test("crop selection follows the requested or collecting job and status preserves growth, away and retry labels", () => {
  const state = snapshot([job("older"), collecting("selected")]);
  assert.equal(economyGardenCrop(state).jobId, "selected");
  assert.equal(economyGardenCrop(state, "older").jobId, "older");
  assert.equal(economyGardenCrop(null), undefined); assert.equal(economyGardenCrop(snapshot([])), null);
  assert.equal(berryCollectionStatus(job(), state, now - 1, null).button, "Растут");
  assert.equal(berryCollectionStatus(collecting(), state, now + 9000, { jobId: "crop", phase: "paused" }).button, "Продолжить");
  const away = snapshot([job(), { kind: "exploration", finishesAt: new Date(now + 1000).toISOString() }]);
  assert.equal(berryCollectionStatus(job(), away, now, null).away, true);
  assert.equal(berryCollectionStatus(job(), away, now, null).disabled, true);
});

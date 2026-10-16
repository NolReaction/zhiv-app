import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const preview = await vite.ssrLoadModule("/features/world/dev/forest-scene-preview.ts");
const { createWorldDevStore, WORLD_DEV_DEFAULTS } = await vite.ssrLoadModule("/features/world/dev/world-dev-store.ts");

test("scene requests accept only supported real actors, fixed trader targets and a different conversational partner", () => {
  assert.equal(preview.WORLD_DEV_SCENES.length, 8);
  assert.deepEqual(preview.normalizeWorldDevSceneRequest({ id: 1, scenario: "conversation", actor: "lopukh" }),
    { id: 1, scenario: "conversation", actor: "lopukh", target: "leaftail" });
  assert.deepEqual(preview.normalizeWorldDevSceneRequest({ id: 2, scenario: "trade-visit", actor: "plesk", target: "mochlik", balance: 999 }),
    { id: 2, scenario: "trade-visit", actor: "plesk", target: "leaftail" });
  for (const invalid of [null, [], {}, { id: 0, actor: "lopukh", scenario: "walk" },
    { id: 1, actor: "fake", scenario: "walk" }, { id: 1, actor: "lopukh", scenario: "warp" },
    { id: 1, actor: "plesk", scenario: "carry" }, { id: 1, actor: "builder", scenario: "butterfly" },
    { id: 1, actor: "plesk", scenario: "watch-birds" }, { id: 1, actor: "leaftail", scenario: "trade-visit" },
    { id: 1, actor: "mochlik", scenario: "conversation", target: "mochlik" }]) {
    assert.equal(preview.normalizeWorldDevSceneRequest(invalid), null);
  }
  const request = preview.normalizeWorldDevSceneRequest({ id: 3, actor: "lopukh", scenario: "carry", position: { x: 0, y: 0 } });
  assert.deepEqual(Object.keys(request), ["id", "scenario", "actor"]); assert.ok(Object.isFrozen(request));
});

test("a finite scene clock freezes for pause and reduced motion and never restarts a terminal result", () => {
  const state = preview.createForestScenePreview({ id: 1, scenario: "walk", actor: "lopukh" });
  for (const invalid of [0, -1, NaN, Infinity]) preview.advanceForestScenePreview(state, invalid);
  preview.advanceForestScenePreview(state, 1, { paused: true }); preview.advanceForestScenePreview(state, 1, { reducedMotion: true });
  assert.equal(state.elapsed, 0); assert.equal(state.phase, "queued");
  const detached = preview.forestScenePreviewFeedback(state); preview.advanceForestScenePreview(state, .1);
  assert.equal(detached.phase, "queued"); assert.equal(state.phase, "running");
  for (let frame = 0; frame < 200; frame++) preview.advanceForestScenePreview(state, .5);
  assert.equal(state.elapsed, 60); assert.equal(state.phase, "complete");
  const completed = structuredClone(state);
  assert.equal(preview.setForestScenePreviewStatus(state, "running", "Снова"), false);
  assert.equal(preview.advanceForestScenePreview(state, .5), false); assert.deepEqual(state, completed);
});

test("scene feedback uses a separate subscription and rejects stale, forged and late reports", () => {
  const store = createWorldDevStore(true); let sceneUpdates = 0, feedbackUpdates = 0;
  store.subscribe(() => sceneUpdates++); store.subscribeSceneFeedback(() => feedbackUpdates++);
  store.patch({ paused: true, timeOfDay: "night", reducedMotion: "on" });
  store.triggerScene("carry", "lopukh");
  const request = store.getSnapshot().scenePreview, snapshot = store.getSnapshot(), initialUpdates = sceneUpdates;
  assert.equal(snapshot.paused, true); assert.equal(snapshot.timeOfDay, "night"); assert.equal(snapshot.reducedMotion, "on");
  assert.ok(request); assert.equal(store.getSceneFeedback().phase, "queued"); assert.equal(store.getServerSceneFeedback(), null);
  store.reportScene(request.id + 1, "running", "Чужой запрос"); store.reportScene(request.id, "unknown", "Неизвестно");
  store.reportScene(request.id, "running", "Идёт к дереву");
  const feedback = store.getSceneFeedback(), reported = feedbackUpdates;
  assert.equal(sceneUpdates, initialUpdates, "runtime feedback cannot re-enter configure/resume");
  assert.equal(store.getSnapshot(), snapshot); assert.ok(Object.isFrozen(feedback));
  store.reportScene(request.id, "running", "Идёт к дереву"); assert.equal(feedbackUpdates, reported);
  store.triggerScene("walk", "kamneshmyg"); const next = store.getSnapshot().scenePreview;
  assert.ok(next.id > request.id);
  store.reportScene(request.id, "complete", "Поздний callback"); assert.equal(store.getSceneFeedback().id, next.id);
  store.reportScene(next.id, "complete", "Готово"); store.reportScene(next.id, "running", "Позднее движение");
  assert.equal(store.getSceneFeedback().phase, "complete");
  store.stopScene(); assert.equal(store.getSnapshot().scenePreview, null);
  store.triggerScene("walk", "lopukh"); const last = store.getSnapshot().scenePreview;
  store.stopScene(); assert.equal(store.getSceneFeedback().phase, "stopped");
  store.reportScene(last.id, "running", "После остановки"); assert.equal(store.getSceneFeedback().phase, "stopped");
  store.reset(); assert.equal(store.getSnapshot(), WORLD_DEV_DEFAULTS); assert.equal(store.getSceneFeedback(), null);
});

test("disabled stores, direct patching and unrelated manual actions cannot leave an active rehearsal behind", () => {
  const disabled = createWorldDevStore(false);
  disabled.subscribeSceneFeedback(() => assert.fail("disabled callback"));
  disabled.triggerScene("walk", "lopukh"); disabled.reportScene(1, "running", "Нет"); disabled.stopScene();
  assert.equal(disabled.getSnapshot(), WORLD_DEV_DEFAULTS); assert.equal(disabled.getSceneFeedback(), null);
  const store = createWorldDevStore(true);
  store.patch({ scenePreview: { id: 1, actor: "lopukh", scenario: "walk" } }); assert.equal(store.getSnapshot().scenePreview, null);
  store.triggerScene("carry", "plesk"); assert.equal(store.getSnapshot().scenePreview, null);
  for (const action of [() => store.triggerPose("greet"), () => store.triggerResident("idle"),
    () => store.triggerBuilder("idle"), () => store.triggerCooking("serve"), () => store.triggerLife("idle"), () => store.triggerScenario("birds")]) {
    store.triggerScene("walk", "lopukh"); action(); assert.equal(store.getSnapshot().scenePreview, null);
    assert.equal(store.getSceneFeedback().phase, "stopped");
  }
});

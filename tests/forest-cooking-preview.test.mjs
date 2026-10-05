import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { previewWorldScene, initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { connectForestSession } = await vite.ssrLoadModule("/features/world/forest-session.ts");
const { advanceForestDirector } = await vite.ssrLoadModule("/features/world/forest-director.ts");
const { requestClearingSleep, advanceClearingActivity, clearingActivityFrame } = await vite.ssrLoadModule("/features/world/clearing-activity.ts");
const { startCookingPreview, advanceCookingPreview, cookingPreviewFrame, cookingPreviewDuration, noticeCookingPreview } =
  await vite.ssrLoadModule("/features/world/dev/forest-cooking-preview.ts");
const { captureForestMemory } = await vite.ssrLoadModule("/features/world/forest-memory.ts");
const scene = previewWorldScene(TILED_WORLD, initialPreviewLevels(TILED_WORLD));
const create = () => connectForestSession(undefined, scene, "world", 1_000_000, 0, () => {}, { persistence: false, sync: false });
const selection = { id: 1, action: "sequence", repeat: false };

test("taps preserve cooking hands, feet and clock, then greet once after the current cycle", () => {
  for (const action of ["sequence", "prepare", "stir", "taste", "serve"]) {
    const session = create(), state = session.state, selected = { id: 8, action, repeat: true };
    try {
      startCookingPreview(state, selected);
      state.elapsed = 2;
      const before = cookingPreviewFrame(state, selected), feet = { ...state.clearing.position };
      for (let i = 0; i < 8; i++) assert.equal(noticeCookingPreview(state, selected), true);
      assert.deepEqual(cookingPreviewFrame(state, selected), before);
      assert.equal(state.clearing.frozen, true);
      const finish = state.cookingPreview.attentionAt;
      state.elapsed = finish - .01; advanceCookingPreview(state, selected);
      assert.ok(state.cookingPreview); assert.deepEqual(state.clearing.position, feet);
      state.elapsed = finish; advanceCookingPreview(state, selected);
      assert.equal(state.cookingPreview, undefined); assert.equal(state.clearing.frozen, false);
      assert.equal(noticeCookingPreview(state, selected), false);
      assert.deepEqual(state.clearing.position, feet);
    } finally { session.release(); }
  }
});

test("outdoor cooking freezes actual feet, reads without mutation and ends exactly once without saved rewards", () => {
  const session = create(), state = session.state;
  try {
    const feet = { ...state.clearing.position };
    assert.equal(startCookingPreview(state, selection), true);
    assert.equal(state.cookingPreview.startedAt, state.elapsed);
    assert.equal(state.clearing.frozen, true);
    state.elapsed += 10;
    const before = JSON.stringify(state), current = cookingPreviewFrame(state, selection);
    assert.equal(current.action, "stir"); assert.equal(current.x, feet.x); assert.equal(current.y, feet.y);
    assert.deepEqual(cookingPreviewFrame(state, selection), current); assert.equal(JSON.stringify(state), before);
    assert.ok(!JSON.stringify(captureForestMemory(state, scene)).includes("cookingPreview"));
    state.elapsed = cookingPreviewDuration(selection);
    advanceCookingPreview(state, selection);
    assert.equal(state.cookingPreview, undefined); assert.equal(state.clearing.frozen, false);
    assert.equal(cookingPreviewFrame(state, selection), null); assert.deepEqual(state.clearing.position, feet);
    advanceCookingPreview(state, selection); assert.equal(state.cookingPreview, undefined);
  } finally { session.release(); }
});

test("confirmed travel and a held or collecting basket prevent preview from stealing actor ownership", () => {
  for (const busy of ["away", "return", "basket", "harvest"]) {
    const session = create(), state = session.state;
    try {
      if (busy === "return") state.journeyTravel = { phase: "returning", jobId: "economic-trip" };
      if (busy === "basket") state.life.garden.basket.held = true;
      if (busy === "harvest") state.life.garden.harvest = { phase: "running", request: { requestId: 4, jobId: "berry-job" } };
      const previous = { position: state.clearing.position, travel: state.journeyTravel, basket: state.life.garden.basket,
        harvest: state.life.garden.harvest };
      assert.equal(startCookingPreview(state, selection, { blocked: busy === "away" }), false);
      assert.equal(state.cookingPreview, undefined);
      assert.strictEqual(state.clearing.position, previous.position); assert.strictEqual(state.journeyTravel, previous.travel);
      assert.strictEqual(state.life.garden.basket, previous.basket); assert.strictEqual(state.life.garden.harvest, previous.harvest);
    } finally { session.release(); }
  }
});

test("individual stages repeat on the shared clock, clear on cancellation and yield immediately to real travel", () => {
  const session = create(), state = session.state, individual = { id: 3, action: "taste", repeat: true };
  try {
    assert.equal(startCookingPreview(state, individual), true);
    state.elapsed = 2;
    const first = cookingPreviewFrame(state, individual);
    state.elapsed += cookingPreviewDuration(individual) * 50;
    advanceCookingPreview(state, individual);
    assert.deepEqual(cookingPreviewFrame(state, individual), first);
    assert.deepEqual(cookingPreviewFrame(state, individual, true), { ...first, phase: .5, frame: 0, steam: .35 });
    advanceCookingPreview(state, individual, { blocked: true });
    assert.equal(state.cookingPreview, undefined); assert.equal(state.clearing.frozen, false);
    assert.equal(startCookingPreview(state, { ...selection, id: 4 }), true);
    advanceCookingPreview(state, null);
    assert.equal(state.cookingPreview, undefined);
  } finally { session.release(); }
});

test("sleeping cooking requests follow the existing exit and start only at visible outdoor feet", () => {
  const session = create(), state = session.state;
  try {
    assert.equal(requestClearingSleep(state.clearing), true);
    for (let elapsed = 0; elapsed < 120 && state.clearing.stage !== "home-sleep"; elapsed += .05) {
      advanceClearingActivity(state.clearing, .05, { enabled: true, blocked: false, dusk: .8, rain: 0, homeAvailable: true });
    }
    assert.equal(state.clearing.stage, "home-sleep");
    const asleep = { ...state.clearing.position };
    assert.equal(startCookingPreview(state, selection, { still: true }), false);
    assert.deepEqual(state.clearing.position, asleep); assert.equal(state.clearing.stage, "home-sleep");
    assert.equal(startCookingPreview(state, selection), true);
    assert.deepEqual(state.clearing.position, asleep); assert.equal(state.cookingPreview.startedAt, null);
    assert.equal(cookingPreviewFrame(state, selection), null);
    for (let elapsed = 0; elapsed < 60 && state.cookingPreview?.startedAt === null; elapsed += .05) {
      const before = { ...state.clearing.position };
      state.elapsed += .05;
      advanceCookingPreview(state, selection);
      const waiting = state.cookingPreview?.startedAt === null, playing = state.cookingPreview?.startedAt != null;
      advanceForestDirector(state, .05, { autoLife: false, blocked: playing, explicitTravel: waiting,
        homeAvailable: true, dusk: .8, rain: 0, butterflies: "off", fireflies: "off" });
      assert.ok(Math.hypot(state.clearing.position.x - before.x, state.clearing.position.y - before.y) < state.clearing.size * .08);
      if (state.cookingPreview?.startedAt === null) assert.equal(cookingPreviewFrame(state, selection), null);
    }
    assert.ok(state.cookingPreview?.startedAt !== null && state.cookingPreview?.startedAt !== undefined);
    const actor = clearingActivityFrame(state.clearing), current = cookingPreviewFrame(state, selection);
    assert.equal(actor.residing, false); assert.equal(actor.opacity, 1); assert.ok(current);
    assert.deepEqual({ x: current.x, y: current.y }, state.clearing.position);
  } finally { session.release(); }
});

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { builderPortraitPose, startBuilderPortraitAnimation } = await vite.ssrLoadModule("/features/world/builder-portrait-animation.ts");
after(() => vite.close());

function clock({ hidden = false, reduce = false } = {}) {
  const callbacks = new Map(), pageListeners = new Map(), mediaListeners = new Map(), frames = [];
  let id = 0;
  const page = { hidden, addEventListener: (type, callback) => pageListeners.set(type, callback), removeEventListener: type => pageListeners.delete(type) };
  const media = { matches: reduce, addEventListener: (type, callback) => mediaListeners.set(type, callback), removeEventListener: type => mediaListeners.delete(type) };
  const host = { requestAnimationFrame(callback) { callbacks.set(++id, callback); return id; }, cancelAnimationFrame: id => callbacks.delete(id), matchMedia: query => { assert.equal(query, "(prefers-reduced-motion: reduce)"); return media; } };
  const stop = startBuilderPortraitAnimation(pose => frames.push(pose), host, page);
  return { frames, callbacks, pageListeners, mediaListeners, stop,
    step(now) { const queued = [...callbacks.values()]; callbacks.clear(); queued.forEach(callback => callback(now)); },
    hide(value) { page.hidden = value; pageListeners.get("visibilitychange")?.(); },
    reduce(value) { media.matches = value; mediaListeners.get("change")?.(); },
  };
}

test("portrait greets, demonstrates work and checks the pouch without driving the world", () => {
  const actions = new Set();
  for (let seconds = 0; seconds < 48; seconds += .125) {
    const pose = builderPortraitPose(seconds); actions.add(pose.action);
    assert.ok(pose.phase >= 0 && pose.phase < 1); assert.ok(pose.frame >= 0 && pose.frame < 192);
  }
  assert.deepEqual([...actions], ["idle", "greet", "work", "inspect"]);
  assert.deepEqual(builderPortraitPose(13), { action: "work", frame: 104, phase: .25, still: false });
  assert.deepEqual(builderPortraitPose(37), builderPortraitPose(13));
  assert.deepEqual(builderPortraitPose(13, true), { action: "idle", frame: 0, phase: 0, still: true });
});

test("hidden and unmounted builder portraits release frame requests and event listeners", () => {
  const c = clock(); assert.equal(c.callbacks.size, 1);
  c.step(0); c.step(125); c.step(250); const last = c.frames.at(-1);
  assert.ok(last.frame > 0);
  c.hide(true); assert.equal(c.callbacks.size, 0);
  c.step(100_000); assert.deepEqual(c.frames.at(-1), last);
  c.hide(false); c.step(110_000); assert.deepEqual(c.frames.at(-1), last, "offscreen time never skips a work gesture");
  c.step(110_125); assert.ok(c.frames.at(-1).frame > last.frame);
  c.stop(); assert.equal(c.callbacks.size, 0); assert.equal(c.pageListeners.size, 0); assert.equal(c.mediaListeners.size, 0);
});

test("motion preferences suspend the portrait clock and paint a steady resting pose", () => {
  const c = clock({ reduce: true }); assert.equal(c.callbacks.size, 0); assert.equal(c.frames[0].still, true);
  c.reduce(false); assert.equal(c.callbacks.size, 1); assert.equal(c.frames.at(-1).still, false);
  c.step(0); c.step(125); c.reduce(true);
  assert.equal(c.callbacks.size, 0); assert.deepEqual(c.frames.at(-1), builderPortraitPose(0, true)); c.stop();
  const hidden = clock({ hidden: true }); assert.equal(hidden.callbacks.size, 0); assert.equal(hidden.frames.length, 0); hidden.stop();
});

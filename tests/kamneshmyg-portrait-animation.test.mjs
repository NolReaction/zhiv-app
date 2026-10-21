import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { kamneshmygPortraitPose, startKamneshmygPortraitAnimation } = await vite.ssrLoadModule("/features/world/characters/kamneshmyg/kamneshmyg-portrait-animation.ts");
after(() => vite.close());

function clock({ hidden = false, reduce = false } = {}) {
  const callbacks = new Map(), pageListeners = new Map(), mediaListeners = new Map(), frames = [];
  let id = 0;
  const page = { hidden, addEventListener: (type, callback) => pageListeners.set(type, callback), removeEventListener: type => pageListeners.delete(type) };
  const media = { matches: reduce, addEventListener: (type, callback) => mediaListeners.set(type, callback), removeEventListener: type => mediaListeners.delete(type) };
  const host = { requestAnimationFrame(callback) { callbacks.set(++id, callback); return id; }, cancelAnimationFrame: id => callbacks.delete(id), matchMedia: query => { assert.equal(query, "(prefers-reduced-motion: reduce)"); return media; } };
  const stop = startKamneshmygPortraitAnimation(pose => frames.push(pose), host, page);
  return { frames, callbacks, pageListeners, mediaListeners, stop,
    step(now) { const queued = [...callbacks.values()]; callbacks.clear(); queued.forEach(callback => callback(now)); },
    hide(value) { page.hidden = value; pageListeners.get("visibilitychange")?.(); },
    reduce(value) { media.matches = value; mediaListeners.get("change")?.(); },
  };
}

test("portrait offers a hello, one mining gesture and a found stone, then repeats its quiet cycle", () => {
  const actions = new Set();
  for (let seconds = 0; seconds < 52; seconds += .125) {
    const pose = kamneshmygPortraitPose(seconds); actions.add(pose.action);
    assert.ok(pose.phase >= 0 && pose.phase < 1); assert.ok(pose.frame >= 0 && pose.frame < 208);
  }
  assert.deepEqual([...actions], ["idle", "greet", "work", "trade"]);
  assert.deepEqual(kamneshmygPortraitPose(13), { action: "work", frame: 104, phase: .25, still: false });
  assert.deepEqual(kamneshmygPortraitPose(39), kamneshmygPortraitPose(13));
  assert.deepEqual(kamneshmygPortraitPose(13, true), { action: "idle", frame: 0, phase: 0, still: true });
  for (const seconds of [-5, NaN, Infinity]) assert.deepEqual(kamneshmygPortraitPose(seconds), kamneshmygPortraitPose(0));
});

test("hidden and unmounted portraits release requests and listeners without consuming hidden time", () => {
  const c = clock(); assert.equal(c.callbacks.size, 1);
  c.step(0); c.step(125); c.step(250); const last = c.frames.at(-1);
  assert.ok(last.frame > 0);
  c.hide(true); assert.equal(c.callbacks.size, 0); c.step(100_000); assert.deepEqual(c.frames.at(-1), last);
  c.hide(false); c.step(110_000); assert.deepEqual(c.frames.at(-1), last, "returning does not jump straight to a tool strike");
  c.step(110_125); assert.ok(c.frames.at(-1).frame > last.frame);
  c.stop(); c.stop(); assert.equal(c.callbacks.size, 0); assert.equal(c.pageListeners.size, 0); assert.equal(c.mediaListeners.size, 0);
});

test("reduced motion freezes the card and an initially hidden card schedules no work", () => {
  const c = clock({ reduce: true }); assert.equal(c.callbacks.size, 0); assert.equal(c.frames[0].still, true);
  c.reduce(false); assert.equal(c.callbacks.size, 1); assert.equal(c.frames.at(-1).still, false);
  c.step(0); c.step(125); c.reduce(true);
  assert.equal(c.callbacks.size, 0); assert.deepEqual(c.frames.at(-1), kamneshmygPortraitPose(0, true)); c.stop();
  const hidden = clock({ hidden: true }); assert.equal(hidden.callbacks.size, 0); assert.equal(hidden.frames.length, 0); hidden.stop();
});

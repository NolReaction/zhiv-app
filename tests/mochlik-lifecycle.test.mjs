import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("2D lifecycle freezes while hidden/paused, settles reduced motion, and disposes RAF", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
  const { mountHabitat } = await vite.ssrLoadModule("/features/mochlik/scene.ts");
  await vite.close(); // Close Vite timers before installing the scene clock.
  const scheduled = new Map(), saved = new Map(); let nextId = 1, disconnected = 0, drawCount = 0, now = 1;
  function install(key, value) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); }
  const realNow = Date.now; Date.now = () => now;
  const timers = new Map(); let timerId = 0, spriteDraws = 0;
  install("setTimeout", (callback, ms) => { const id = ++timerId; timers.set(id, { at: now + ms, callback }); return id; });
  install("clearTimeout", id => timers.delete(id));
  const flushTimers = () => { for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } };
  const context = new Proxy({
    getImageData: (_x, _y, w, h) => { const data = new Uint8ClampedArray(w * h * 4).fill(255); data[0] = data[1] = data[2] = 0; return { data }; },
    createRadialGradient: () => ({ addColorStop() {} }), drawImage: source => { drawCount++; if (source.width === 48) spriteDraws++; },
  }, { get: (target, key) => key in target ? target[key] : () => {} });
  const canvas = () => ({ width: 16, height: 16, clientWidth: 320, getContext: () => context });
  install("document", { createElement: () => canvas() }); install("window", { devicePixelRatio: 2 });
  install("Image", class { naturalWidth = 16; naturalHeight = 16; set src(_) { queueMicrotask(() => this.onload()); } });
  install("ResizeObserver", class { observe() {} disconnect() { disconnected++; } });
  install("requestAnimationFrame", callback => { const id = nextId++; scheduled.set(id, callback); return id; });
  install("cancelAnimationFrame", id => scheduled.delete(id));
  const frames = count => { for (let i = 0; i < count; i++) { now += 34; const current = [...scheduled.values()]; scheduled.clear(); spriteDraws = 0; current.forEach(callback => callback(now)); flushTimers(); assert.ok(spriteDraws <= 1, "one pet sprite per rendered frame, including peeking"); } };
  let scene;
  try {
    let activity, ready = 0, failures = 0;
    const options = { paused: false, reducedMotion: false, lampOn: false, dusk: false };
    scene = mountHabitat(canvas(), options, { activity: value => { activity = value; }, ready: () => ready++, failure: () => failures++ });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ready, 1); assert.equal(failures, 0); assert.equal(scheduled.size, 1);
    frames(2300); assert.equal(activity, "sleep");
    scene.configure({ ...options, paused: true }); const frozen = drawCount;
    for (let i = 0; i < 100; i++) scene.notice(); frames(100);
    assert.equal(scheduled.size, 0); assert.equal(activity, "sleep"); assert.equal(drawCount, frozen);
    scene.configure(options); frames(2); assert.equal(activity, "wake");
    scene.configure({ ...options, paused: true, reducedMotion: true });
    const before = drawCount; scene.notice(); frames(10); assert.equal(drawCount, before);
    scene.dispose(); assert.equal(scheduled.size, 0);

    scene = mountHabitat(canvas(), { ...options, reducedMotion: true }, { activity: value => { activity = value; }, ready() {}, failure() { failures++; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(activity, "idle"); assert.equal(scheduled.size, 0);
    now += 61_000; flushTimers(); assert.equal(activity, "sleep");
    scene.notice(); assert.equal(activity, "greet"); assert.equal(scheduled.size, 0);
    scene.invite("home"); assert.equal(activity, "sleep");
    scene.configure({ ...options, reducedMotion: true, paused: true, lampOn: true });
    assert.equal(activity, "sleep");
    scene.configure({ ...options, reducedMotion: true, lampOn: true }); assert.equal(activity, "sleep");
    scene.notice(); assert.equal(activity, "greet");
    assert.equal(scheduled.size, 0); assert.equal(failures, 0);
    scene.dispose(); assert.equal(disconnected, 2); assert.equal(scheduled.size, 0); assert.equal(timers.size, 0);

    const daylight = { ...options, lampOn: true };
    scene = mountHabitat(canvas(), daylight, { activity: value => { activity = value; }, ready() {}, failure() { failures++; } });
    await new Promise(resolve => setImmediate(resolve));
    for (let i = 0; i < 1500 && activity !== "peek"; i++) frames(1);
    assert.equal(activity, "peek"); frames(40);
    scene.configure({ ...daylight, backgrounded: true }); const beforeBackground = drawCount;
    now += 3600_000; frames(1); assert.equal(drawCount, beforeBackground); assert.equal(scheduled.size, 0);
    scene.configure(daylight); frames(2); assert.equal(activity, "sleep", "return already asleep without walking home");
    scene.notice(); frames(2); assert.equal(activity, "stir");
    frames(1100); assert.equal(activity, "sleep", "one tap cannot wake a long-absent pet");
    scene.notice(); frames(2); assert.equal(activity, "stir");
    scene.notice(); frames(2); assert.equal(activity, "wake");
    scene.dispose();

    // The explicit workshop pause freezes ecology; render suspension above doesn't.
    scene = mountHabitat(canvas(), daylight, { activity: value => { activity = value; }, ready() {}, failure() { failures++; } });
    await new Promise(resolve => setImmediate(resolve));
    scene.configure({ ...daylight, paused: true }); now += 3600_000;
    scene.configure(daylight); frames(80); assert.equal(activity, "idle");
    scene.dispose();

    // Reduced motion still reaches the inactivity deadline without an animation loop.
    scene = mountHabitat(canvas(), { ...daylight, reducedMotion: true }, { activity: value => { activity = value; }, ready() {}, failure() { failures++; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(activity, "idle"); assert.equal(scheduled.size, 0); assert.equal(timers.size, 1);
    now += 61_000; flushTimers(); assert.equal(activity, "sleep"); assert.equal(scheduled.size, 0);
    scene.notice(); assert.equal(activity, "greet"); assert.equal(scheduled.size, 0);
    scene.configure({ ...daylight, reducedMotion: true, paused: true }); assert.equal(timers.size, 0);
    scene.dispose(); assert.equal(timers.size, 0); assert.equal(failures, 0);

    // A new scene restores rest before the art's first visible frame, scoped to this account.
    const storage = new Map();
    window.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
    const remembered = { ...daylight, presenceKey: "mochlik:test-user" };
    scene = mountHabitat(canvas(), remembered, { activity: value => { activity = value; }, ready() {}, failure() { failures++; } });
    await new Promise(resolve => setImmediate(resolve)); frames(5); scene.dispose();
    now += 300_000;
    scene = mountHabitat(canvas(), remembered, { activity: value => { activity = value; }, ready() { assert.equal(activity, "sleep"); }, failure() { failures++; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(activity, "sleep");
    scene.notice(); scene.notice(); scene.notice(); frames(2); assert.equal(activity, "wake");
    scene.dispose();
    scene = mountHabitat(canvas(), { ...remembered, presenceKey: "mochlik:another-user" }, { activity: value => { activity = value; }, ready() {}, failure() { failures++; } });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(activity, "idle"); scene.dispose();
    assert.equal(scheduled.size, 0); assert.equal(timers.size, 0); assert.equal(failures, 0);

    // Covering the circle with an actively used map is not a long user absence.
    const shared = { ...daylight, presenceKey: "mochlik:shared-map" };
    scene = mountHabitat(canvas(), shared, { activity: value => { activity = value; }, ready() {}, failure() { failures++; } });
    await new Promise(resolve => setImmediate(resolve));
    scene.configure({ ...shared, backgrounded: true }); now += 360_000;
    storage.set(shared.presenceKey, JSON.stringify({ seenAt: now, inactiveFor: 0, resting: false, deepSleep: false }));
    scene.configure(shared); frames(3);
    assert.notEqual(activity, "sleep"); assert.notEqual(activity, "stir");
    scene.dispose(); assert.equal(scheduled.size, 0); assert.equal(timers.size, 0);

    // Render every extended moment through the real renderer and its cached pixel rig.
    const seen = new Set();
    const night = { ...daylight, dusk: true, bestStreakDays: 30 };
    scene = mountHabitat(canvas(), night, { activity: value => { activity = value; seen.add(value); }, ready() {}, failure() { failures++; } });
    await new Promise(resolve => setImmediate(resolve));
    for (let i = 0; i < 220; i++) { scene.notice(); frames(50); }
    for (const action of ["toss", "carry", "show", "shelter", "shelter-peek", "wonder", "shake"]) assert.ok(seen.has(action), action);
    scene.configure({ ...night, reducedMotion: true });
    assert.equal(scheduled.size, 0);
    now += 61_000; flushTimers(); assert.equal(activity, "sleep");
    scene.configure({ ...night, reducedMotion: true, bestStreakDays: 0 }); assert.equal(activity, "sleep");
    scene.dispose(); assert.equal(scheduled.size, 0); assert.equal(timers.size, 0); assert.equal(failures, 0);
  } finally {
    scene?.dispose(); Date.now = realNow;
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});

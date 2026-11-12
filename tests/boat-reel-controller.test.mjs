import assert from "node:assert/strict";
import test, { after, afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), virtual = "virtual:boat-reel-controller-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/boat-reel-controller-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  plugins: [{ name: "boat-reel-controller-lifecycle", enforce: "pre",
    resolveId(id) { if (id === virtual) return `\0${virtual}`; },
    load(id) { if (id === `\0${virtual}`) return `
      let slots = [], cursor = 0, layout = [], effects = [], dirty = false;
      export function unmount() { for (const slot of slots) slot?.cleanup?.(); slots = []; layout = []; effects = []; dirty = false; }
      export function render() { cursor = 0; dirty = false; }
      export function changed() { return dirty; }
      export function useRef(initial) { return slots[cursor++] ??= { current: initial }; }
      export function useState(initial) {
        const index = cursor++; slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
        return [slots[index].value, next => {
          const value = typeof next === 'function' ? next(slots[index].value) : next;
          if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; }
        }];
      }
      export function useCallback(callback, dependencies) {
        const index = cursor++, previous = slots[index];
        if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) slots[index] = { dependencies, callback };
        return slots[index].callback;
      }
      function enqueue(queue, callback, dependencies) {
        const index = cursor++, previous = slots[index];
        if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
          slots[index] = { dependencies, cleanup: previous?.cleanup };
          queue.push(() => { slots[index].cleanup?.(); slots[index].cleanup = callback(); });
        }
      }
      export function useLayoutEffect(callback, deps) { enqueue(layout, callback, deps); }
      export function useEffect(callback, deps) { enqueue(effects, callback, deps); }
      export function flushEffects() { const pending = [...layout, ...effects]; layout = []; effects = []; pending.forEach(callback => callback()); }
    `; },
    transform(source, id) { if (id.endsWith("/features/economy/ui/boat/use-boat-reel-controller.ts"))
      return source.replace('from "react";', `from "${virtual}";`); },
  }] });
after(() => vite.close());
const hooks = await vite.ssrLoadModule(virtual);
const { useBoatReelController: invokeController } = await vite.ssrLoadModule("/features/economy/ui/boat/use-boat-reel-controller.ts");
const { initialBoatReel, stepBoatReel, replayBoatReel } = await vite.ssrLoadModule("/features/economy/domain/boat-reel.ts");
const checkpoint = await vite.ssrLoadModule("/features/economy/ui/boat/boat-reel-checkpoint.ts");
const at = Date.parse("2026-11-03T10:00:00Z"), globals = ["window", "document", "requestAnimationFrame", "cancelAnimationFrame"];
let clock, nextFrame, frames, values, savedGlobals;
const memory = () => ({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) });
beforeEach(t => {
  clock = 100; nextFrame = 0; frames = new Map(); values = new Map();
  savedGlobals = globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  Object.assign(globalThis, { window: Object.assign(new EventTarget(), { sessionStorage: memory() }),
    document: Object.assign(new EventTarget(), { hidden: false }),
    requestAnimationFrame: callback => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id) });
  t.mock.method(performance, "now", () => clock);
});
afterEach(() => {
  hooks.unmount();
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  }
});
const challenge = () => ({ id: crypto.randomUUID(), rulesVersion: 1, seed: 17, tickMs: 50, maxTicks: 600,
  zoneWidth: 3200, difficulty: 1, startedAt: new Date(at).toISOString(), expiresAt: new Date(at + 120000).toISOString() });
function fixture(overrides = {}) {
  const submissions = [], props = { owner: "owner", voyageId: "voyage", challenge: challenge(), now: at, disabled: false,
    onSubmit: submission => { submissions.push(structuredClone(submission)); return true; }, ...overrides };
  let value;
  const render = patch => {
    Object.assign(props, patch);
    for (let iteration = 0; iteration < 10; iteration++) {
      hooks.render(); value = invokeController(props); hooks.flushEffects();
      if (!hooks.changed()) return value;
    }
    assert.fail("Controller effects did not settle");
  };
  const frame = (elapsed = 50) => {
    clock += elapsed;
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(clock));
    return render();
  };
  render();
  return { props, submissions, render, frame, get value() { return value; } };
}
function saveTerminal(attempt, owner = "owner", voyageId = "voyage") {
  let reel = initialBoatReel(attempt);
  while (reel.status === "active") reel = stepBoatReel(attempt, reel, false);
  checkpoint.writeBoatReelCheckpoint(memory(), checkpoint.boatReelCheckpointKey(owner, voyageId, attempt.id), attempt, reel, []);
  return reel;
}

test("manual hooking accepts only the live bite and survives an immediate remount before the first tick", () => {
  const attempt = { ...challenge(), rulesVersion: 6, fishRarity: "common", resistance: "steady", motorResponse: 0, hullDamping: 0, biteAt: new Date(at + 4000).toISOString() };
  const f = fixture({ challenge: attempt }); f.frame(0); f.value.hookFish(); f.render(); assert.equal(f.value.playing, false);
  f.frame(4000); assert(f.value.awaitingHook); assert.equal(f.value.reel.tick, 0);
  f.frame(1200); f.value.hookFish(); f.render(); assert(f.value.playing); assert.equal(f.value.reel.tick, 0);
  hooks.unmount();
  const restored = fixture({ challenge: attempt, now: at + 5249 }); restored.frame(0);
  assert(restored.value.playing); assert.equal(restored.value.missedBite, false);
  restored.frame(1); assert.equal(restored.value.reel.tick, 1);
});

test("a saved pre-hook attempt starts on the server bite without a click and never changes its issued rules", () => {
  const attempt = { ...challenge(), biteAt: new Date(at + 4000).toISOString() };
  const f = fixture({ challenge: attempt }); f.frame(0);
  assert(Object.isFrozen(f.value.challenge)); assert.equal(f.value.castStage, "casting");
  f.frame(1200); assert.equal(f.value.castStage, "soaking");
  f.frame(2799); assert.equal(f.value.playing, false); assert.equal(f.value.reel.tick, 0);
  f.render({ challenge: { ...attempt, seed: 700 } });
  f.frame(1); assert.equal(f.value.playing, true); assert.equal(f.value.reel.tick, 0);
  assert.equal(f.value.challenge.seed, attempt.seed);
  f.frame(50); assert.equal(f.value.reel.tick, 1); assert.deepEqual(f.submissions, []);
});

test("display frames share the exact tick clock, collapse same-tick input and replay the saved trace", () => {
  const f = fixture(); f.frame(0); assert.equal(f.value.playing, true, "older challenges have no wait");
  f.value.changeHeld(true); f.value.changeHeld(false); f.value.changeHeld(true);
  f.frame(16); f.frame(16); f.frame(17); assert.equal(f.value.reel.tick, 0);
  f.frame(1); assert.deepEqual(f.value.reel, stepBoatReel(f.value.challenge, initialBoatReel(f.value.challenge), true));
  f.value.changeHeld(false); f.frame(100); window.dispatchEvent(new Event("blur")); f.render();
  const key = checkpoint.boatReelCheckpointKey("owner", "voyage", f.value.challenge.id), saved = JSON.parse(values.get(key));
  assert.deepEqual(saved.inputs, [{ tick: 0, held: true }, { tick: 1, held: false }]);
  assert.equal(saved.endTick, 3); assert.deepEqual(replayBoatReel(f.value.challenge, saved.inputs, saved.endTick), f.value.reel);
});

test("blur, hiding, pagehide and trays release the line and tick through every unattended step", () => {
  for (const kind of ["blur", "hidden", "pagehide", "freeze", "tray"]) {
    const f = fixture(); f.frame(0); f.value.changeHeld(true); f.frame(50);
    if (kind === "blur") window.dispatchEvent(new Event("blur"));
    if (kind === "hidden") { document.hidden = true; document.dispatchEvent(new Event("visibilitychange")); }
    if (kind === "pagehide") window.dispatchEvent(new Event("pagehide"));
    if (kind === "freeze") document.dispatchEvent(new Event("freeze"));
    if (kind === "tray") f.render({ suspended: true });
    f.render(); assert(f.value.playing, kind); assert.equal(f.value.held, false, kind);
    f.frame(5000);
    let expected = stepBoatReel(f.value.challenge, initialBoatReel(f.value.challenge), true);
    while (expected.tick < 101 && expected.status === "active") expected = stepBoatReel(f.value.challenge, expected, false);
    assert.deepEqual(f.value.reel, expected, kind);
    if (expected.status !== "active") {
      assert.equal(f.submissions.length, 1, kind);
      assert.deepEqual(replayBoatReel(f.value.challenge, f.submissions[0].inputs, f.submissions[0].endTick), expected);
    }
    document.hidden = false; hooks.unmount();
  }
});

test("an unrelated pending write delays delivery but does not stop hooking or steering the fish", () => {
  const attempt = { ...challenge(), rulesVersion: 6, fishRarity: "common", resistance: "steady", motorResponse: 0,
    hullDamping: 0, biteAt: new Date(at + 4000).toISOString() };
  const f = fixture({ challenge: attempt, ownCast: true, disabled: true });
  f.frame(4000); f.value.hookFish(); f.value.changeHeld(true); f.frame(100);
  assert.equal(f.value.playing, true); assert.equal(f.value.held, true);
  f.value.changeHeld(false); f.render(); assert.equal(f.value.held, false);
  while (f.value.reel.status === "active") f.frame(50);
  assert.equal(f.submissions.length, 0);
  f.render({ disabled: false }); assert.equal(f.submissions.length, 1);
});

test("a slow frame honors the previous input up to the next actual input time", () => {
  const f = fixture(); f.frame(0);
  clock += 510; f.value.changeHeld(true); f.frame(50);
  const expected = replayBoatReel(f.value.challenge, [{ tick: 10, held: true }], 11);
  assert.deepEqual(f.value.reel, expected); assert(f.value.playing);
});

test("an automatic legacy bite advances from its issued bite time behind a tray", () => {
  const f = fixture({ suspended: true }); f.frame(0);
  document.hidden = true; f.frame(500);
  assert(f.value.playing); assert.equal(f.value.held, false); assert.equal(f.value.reel.tick, 10);
  document.hidden = false; f.render({ suspended: false }); f.frame(50); assert.equal(f.value.reel.tick, 11);
});

test("an unhooked local cast expires behind an overlay or across a reload; a late foreign viewer never settles it implicitly", () => {
  const attempt = { ...challenge(), rulesVersion: 6, fishRarity: "common", resistance: "steady", motorResponse: 0, hullDamping: 0, biteAt: new Date(at + 4000).toISOString() };
  const obscured = fixture({ challenge: attempt, ownCast: true, suspended: true });
  obscured.frame(7300);
  assert.equal(obscured.submissions.length, 1); assert.equal(obscured.submissions[0].missedBite, true); hooks.unmount();
  const same = fixture({ challenge: attempt, now: at + 8000, ownCast: true }); same.frame(0);
  assert.equal(same.submissions.length, 1); assert.equal(same.submissions[0].missedBite, true); hooks.unmount();
  const other = fixture({ challenge: attempt, now: at + 8000 }); other.frame(0);
  assert.equal(other.submissions.length, 0); assert(other.value.missedElsewhere);
  other.value.confirmMiss(); other.render(); assert.equal(other.submissions.length, 1);
});

test("a caught or escaped fish automatically dispatches its exact terminal trace once, even while waiting for a receipt", () => {
  for (const steer of [true, false]) {
    const f = fixture({ challenge: { ...challenge(), seed: 37 } }); f.frame(0);
    while (f.value.reel.status === "active") {
      const reel = f.value.reel; f.value.changeHeld(steer && reel.fish > reel.bar + reel.velocity * 4); f.frame(50);
    }
    assert.equal(f.value.reel.status, steer ? "caught" : "escaped"); assert(f.value.waitingForConfirmation);
    f.frame(16); f.render(); f.value.submit(); f.render({ queued: true, disabled: true, uncertain: true });
    assert.equal(f.submissions.length, 1);
    const request = f.submissions[0]; assert.deepEqual(replayBoatReel(f.value.challenge, request.inputs, request.endTick), f.value.reel);
    hooks.unmount(); assert.equal(frames.size, 0);
  }
});

test("reopening a hooked draft spends away time with the line released and submits the exact resulting trace", () => {
  const attempt = challenge(), f = fixture({ challenge: attempt }); f.frame(0); f.value.changeHeld(true); f.frame(150);
  hooks.unmount(); assert.equal(frames.size, 0);
  const restored = fixture({ challenge: attempt, now: at + 20000 }); restored.frame(0);
  assert.equal(restored.value.held, false);
  let expected = initialBoatReel(attempt);
  while (expected.status === "active" && expected.tick < 400) expected = stepBoatReel(attempt, expected, expected.tick < 3);
  assert.deepEqual(restored.value.reel, expected); assert.equal(expected.status, "escaped");
  assert.equal(restored.submissions.length, 1);
  assert.deepEqual(restored.submissions[0].inputs, [{ tick: 0, held: true }, { tick: 3, held: false }]);
  hooks.unmount();
  const foreign = fixture({ challenge: attempt, owner: "someone-else" }); foreign.frame(0);
  assert.equal(foreign.value.reel.tick, 0); hooks.unmount();
  const other = fixture({ challenge: attempt, voyageId: "another-voyage" }); other.frame(0);
  assert.equal(other.value.reel.tick, 0);
  assert.equal(values.has(checkpoint.boatReelCheckpointKey("owner", "voyage", attempt.id)), false);
});

test("reopening a timed hook beyond its cast deadline replays the unattended loss once through deferred delivery", () => {
  const attempt = challenge(), f = fixture({ challenge: attempt }); f.frame(0); f.value.changeHeld(true); f.frame(150);
  hooks.unmount();
  const restored = fixture({ challenge: attempt, now: at + 180000 }); restored.frame(0);
  assert.equal(restored.value.expired, false); assert.equal(restored.value.reel.status, "escaped");
  assert.equal(restored.submissions.length, 1);
  assert.deepEqual(replayBoatReel(attempt, restored.submissions[0].inputs, restored.submissions[0].endTick), restored.value.reel);
  hooks.unmount();
  const tooLate = fixture({ challenge: attempt, now: at + 120000 + 86_400_001 }); tooLate.frame(0);
  assert.equal(tooLate.value.expired, true); assert.equal(tooLate.submissions.length, 0);
});

test("a pre-update hooked draft without a reel clock preserves its trace and cannot restore a free pause", () => {
  const attempt = { ...challenge(), rulesVersion: 6, fishRarity: "common", resistance: "steady", motorResponse: 0, hullDamping: 0, biteAt: new Date(at + 4000).toISOString() };
  const old = replayBoatReel(attempt, [{ tick: 0, held: true }], 3);
  checkpoint.writeBoatReelCheckpoint(memory(), checkpoint.boatReelCheckpointKey("owner", "voyage", attempt.id), attempt, old, [{ tick: 0, held: true }], true);
  const restored = fixture({ challenge: attempt, now: at + 7700 }); restored.frame(0);
  assert.deepEqual(restored.value.reel, replayBoatReel(attempt, [{ tick: 0, held: true }, { tick: 3, held: false }], 10));
  assert(restored.value.playing);
});

test("a remounted terminal draft waits for permissions, and an already queued receipt never dispatches twice", () => {
  const attempt = challenge(), terminal = saveTerminal(attempt);
  const f = fixture({ challenge: attempt, queued: true }); f.frame(0);
  assert.equal(f.submissions.length, 0); assert(f.value.waitingForConfirmation);
  f.render({ queued: false, uncertain: true }); assert.equal(f.submissions.length, 0);
  f.render({ disabled: true, uncertain: false }); assert.equal(f.submissions.length, 0);
  f.render({ disabled: false }); assert.equal(f.submissions.length, 1);
  assert.deepEqual(f.value.reel, terminal); f.render(); f.frame(0); assert.equal(f.submissions.length, 1);
});

test("a refused offline write preserves the finished draft and retries on reconnect, including synchronous re-entry", () => {
  const attempt = challenge(); saveTerminal(attempt); let calls = 0, f;
  f = fixture({ challenge: attempt, onSubmit() { calls++; f.value.submit(); return false; } }); f.frame(0);
  assert.equal(calls, 1); assert(f.value.retryNeeded);
  f.frame(16); f.frame(16); assert.equal(calls, 1, "no render retry loop");
  const completed = f.value.reel;
  f.render({ onSubmit() { calls++; throw Error("transport unavailable"); } });
  f.value.submit(); assert.equal(calls, 2); assert(f.value.retryNeeded);
  f.render({ onSubmit() { calls++; return true; } });
  window.dispatchEvent(new Event("online")); f.render(); f.value.submit(); assert.equal(calls, 3);
  assert.deepEqual(f.value.reel, completed); assert(f.value.waitingForConfirmation);
});

test("a definitive server rejection exposes a retry without manufacturing a second result", () => {
  const attempt = challenge(); saveTerminal(attempt);
  const f = fixture({ challenge: attempt }); f.frame(0); assert.equal(f.submissions.length, 1);
  f.render({ disabled: true, queued: true }); f.render({ queued: false, disabled: false, error: "World changed" });
  assert.equal(f.value.retryNeeded, true); assert.equal(f.submissions.length, 1);
  f.render({ error: null }); f.value.submit(); f.render();
  assert.deepEqual(f.submissions[0], f.submissions[1]);
});

test("expiry rejects a stale terminal trace while an already-queued result can wait beyond its challenge deadline", () => {
  const attempt = challenge(); saveTerminal(attempt);
  const f = fixture({ challenge: attempt, disabled: true }); f.frame(0); clock += 120000;
  f.render({ disabled: false }); f.value.submit(); f.frame(0); assert.deepEqual(f.submissions, []);
  assert(f.value.expired);
  f.render({ queued: true, uncertain: true, now: at + 120001 }); assert(f.value.waitingForConfirmation); assert.equal(f.value.expired, false);
});

test("denied session storage cannot stop play or fabricate a completed submission", () => {
  Object.defineProperty(window, "sessionStorage", { get() { throw Error("Storage denied"); } });
  const f = fixture(); f.frame(0); f.value.changeHeld(true); f.frame(50);
  assert.equal(f.value.reel.tick, 1); assert.deepEqual(f.submissions, []);
  hooks.unmount(); assert.equal(frames.size, 0);
});

import assert from "node:assert/strict";
import test, { after, afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), virtual = "virtual:boat-reel-controller-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/boat-reel-controller-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "boat-reel-controller-lifecycle", enforce: "pre",
    resolveId(id) { if (id === virtual) return `\0${virtual}`; },
    load(id) { if (id === `\0${virtual}`) return `
      let slots = [], cursor = 0, effects = [], dirty = false;
      export function unmount() { for (const slot of slots) slot?.cleanup?.(); slots = []; effects = []; dirty = false; }
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
      export function useEffect(callback, dependencies) {
        const index = cursor++, previous = slots[index];
        if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
          slots[index] = { dependencies, cleanup: previous?.cleanup };
          effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = callback(); });
        }
      }
      export function flushEffects() { const pending = effects; effects = []; pending.forEach(callback => callback()); }
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

test("mounting freezes its keyed challenge and never starts or submits without explicit input", () => {
  const f = fixture(), original = structuredClone(f.props.challenge);
  assert.equal(Object.isFrozen(f.value.challenge), true);
  assert.equal(f.value.ready, false); f.value.togglePlay(); f.frame(0);
  assert.equal(f.value.ready, true); assert.equal(f.value.playing, false); assert.equal(f.value.reel.tick, 0);
  f.props.challenge.seed = 999;
  f.render({ challenge: { ...original, seed: 101, expiresAt: new Date(at + 1000).toISOString() } });
  assert.deepEqual(f.value.challenge, original);
  f.frame(1000); assert.equal(f.value.reel.tick, 0); assert.equal(f.value.expired, false);
  assert.deepEqual(f.submissions, []);
});

test("50ms sampling collapses same-tick controls and checkpoints replay the exact simulated state", () => {
  const f = fixture(); f.frame(0); f.value.togglePlay(); f.frame(50);
  f.value.changeHeld(true); f.value.changeHeld(false); f.value.changeHeld(true);
  f.frame(49); assert.equal(f.value.reel.tick, 0); f.frame(1);
  assert.deepEqual(f.value.reel, stepBoatReel(f.value.challenge, initialBoatReel(f.value.challenge), true));
  f.value.changeHeld(false); f.frame(100); f.value.togglePlay(); f.render();
  const key = checkpoint.boatReelCheckpointKey("owner", "voyage", f.value.challenge.id), saved = JSON.parse(values.get(key));
  assert.deepEqual(saved.inputs, [{ tick: 0, held: true }, { tick: 1, held: false }]);
  assert.equal(saved.endTick, 3);
  assert.deepEqual(replayBoatReel(f.value.challenge, saved.inputs, saved.endTick), f.value.reel);
  assert.equal(f.value.playing, false); assert.equal(f.value.held, false); assert.deepEqual(f.submissions, []);
});

test("blur, hidden pages and long suspended frames pause without inventing time or held inputs", () => {
  const f = fixture(); f.frame(0);
  for (const kind of ["blur", "hidden", "long"]) {
    f.value.togglePlay(); f.frame(0); f.value.changeHeld(true); f.frame(50);
    const tick = f.value.reel.tick;
    if (kind === "blur") window.dispatchEvent(new Event("blur"));
    else if (kind === "hidden") { document.hidden = true; document.dispatchEvent(new Event("visibilitychange")); }
    else f.frame(501);
    f.render(); assert.equal(f.value.playing, false, kind); assert.equal(f.value.held, false, kind);
    f.frame(500); assert.equal(f.value.reel.tick, tick, kind);
    document.hidden = false; document.dispatchEvent(new Event("visibilitychange")); f.frame(50);
    assert.equal(f.value.playing, false, kind); assert.equal(f.value.reel.tick, tick, kind);
  }
  assert.deepEqual(f.submissions, []);
});

test("a complete live control trace pauses at its exact bounded result and submits only replayable input", () => {
  const f = fixture({ challenge: { ...challenge(), seed: 37 } }); f.frame(0);
  let focused = 0; f.value.finishButton.current = { focus() { focused++; } };
  f.value.togglePlay(); f.frame(0);
  while (f.value.reel.status === "active") {
    const reel = f.value.reel;
    f.value.changeHeld(reel.fish > reel.bar + reel.velocity * 4); f.frame(50);
  }
  assert.equal(f.value.reel.status, "caught"); assert(f.value.reel.tick <= 600);
  assert.equal(f.value.playing, false); assert.equal(f.value.held, false); assert.equal(focused, 1);
  const terminal = f.value.reel; f.frame(500); assert.deepEqual(f.value.reel, terminal);
  f.value.submit(); f.value.submit(); assert.equal(f.submissions.length, 1);
  const submission = f.submissions[0];
  assert(submission.inputs.every(input => input.tick < submission.endTick));
  assert.deepEqual(replayBoatReel(f.value.challenge, submission.inputs, submission.endTick), terminal);
});

test("reopening restores the tab trace paused, scopes drafts by owner/voyage and cancels every scheduled frame", () => {
  const attempt = challenge(), f = fixture({ challenge: attempt }); f.frame(0); f.value.togglePlay(); f.frame(0);
  f.value.changeHeld(true); f.frame(150); const previous = f.value.reel;
  hooks.unmount(); assert.equal(frames.size, 0);
  const restored = fixture({ challenge: attempt }); restored.frame(0);
  assert.deepEqual(restored.value.reel, previous); assert.equal(restored.value.playing, false); assert.equal(restored.value.held, false);
  restored.frame(500); assert.deepEqual(restored.value.reel, previous); hooks.unmount();
  const foreign = fixture({ challenge: attempt, owner: "someone-else" }); foreign.frame(0);
  assert.equal(foreign.value.reel.tick, 0); hooks.unmount();
  const nextVoyage = fixture({ challenge: attempt, voyageId: "next-voyage" }); nextVoyage.frame(0);
  assert.equal(nextVoyage.value.reel.tick, 0);
  assert.equal(values.has(checkpoint.boatReelCheckpointKey("owner", "voyage", attempt.id)), false);
  nextVoyage.value.togglePlay(); assert(frames.size > 1); hooks.unmount(); assert.equal(frames.size, 0);
});

test("terminal traces submit once even through reentrant stale handlers and retry only after the pending lifecycle settles", () => {
  const attempt = challenge(), terminal = saveTerminal(attempt), calls = [];
  let f;
  f = fixture({ challenge: attempt, onSubmit(submission) { calls.push(structuredClone(submission)); f.value.submit(); return true; } });
  f.frame(0); assert.deepEqual(f.value.reel, terminal);
  const stale = f.value.submit; stale(); stale(); assert.equal(calls.length, 1);
  assert.deepEqual(replayBoatReel(attempt, calls[0].inputs, calls[0].endTick), terminal);
  f.render({ disabled: true }); assert.equal(f.value.waitingForConfirmation, true);
  f.render({ disabled: false, uncertain: true }); f.value.submit(); assert.equal(calls.length, 1);
  f.render({ disabled: false, uncertain: false }); f.value.submit(); assert.equal(calls.length, 2);
});

test("a locally refused or throwing dispatch stays retryable without changing its completed trace", () => {
  const attempt = challenge(); saveTerminal(attempt); let calls = 0;
  const f = fixture({ challenge: attempt, onSubmit() { calls++; return false; } }); f.frame(0);
  const completed = f.value.reel; f.value.submit(); f.value.submit(); assert.equal(calls, 2);
  f.render({ onSubmit() { calls++; throw Error("Local dispatch unavailable"); } });
  assert.throws(() => f.value.submit(), /Local dispatch unavailable/);
  f.render({ onSubmit() { calls++; return true; } }); f.value.submit(); f.value.submit();
  assert.equal(calls, 4); assert.deepEqual(f.value.reel, completed);
});

test("an idle committed render releases a local receipt when a fast refusal batches away the busy frame", () => {
  const attempt = challenge(); saveTerminal(attempt); const f = fixture({ challenge: attempt }); f.frame(0);
  const first = f.value.submit; first(); first(); assert.equal(f.submissions.length, 1);
  f.render(); assert.equal(f.value.waitingForConfirmation, false);
  f.value.submit(); f.value.submit(); assert.equal(f.submissions.length, 2);
  assert.deepEqual(f.submissions[0], f.submissions[1], "An explicit retry must retain the same legal terminal trace");
});

test("deadline checks reject stale-clock submission before the next frame while uncertain receipts keep their pending state", () => {
  const attempt = challenge(); saveTerminal(attempt); const f = fixture({ challenge: attempt }); f.frame(0);
  clock += 120000; f.value.submit(); assert.deepEqual(f.submissions, []);
  f.frame(0); assert.equal(f.value.expired, true); assert.equal(f.value.seconds, 0);
  assert.equal(f.value.status, "Рыба ушла");
  f.render({ disabled: true, uncertain: true, now: at + 120001 });
  assert.equal(f.value.waitingForConfirmation, true); assert.equal(f.value.expired, false); assert.equal(f.value.status, "Проверяем результат");
  f.value.submit(); assert.deepEqual(f.submissions, []);
});

test("denied session storage cannot stop play or fabricate a completed submission", () => {
  Object.defineProperty(window, "sessionStorage", { get() { throw Error("Storage denied"); } });
  const f = fixture(); f.value.submit(); f.value.changeHeld(true); f.frame(0);
  f.value.togglePlay(); f.frame(0); f.value.changeHeld(true); f.frame(50);
  assert.equal(f.value.reel.tick, 1); assert.deepEqual(f.submissions, []);
  f.value.togglePlay(); f.value.togglePlay(); hooks.unmount(); assert.equal(frames.size, 0);
});

test("unmount before the first frame and rapid start/pause/start both cancel every pending focus callback", () => {
  fixture(); hooks.unmount(); assert.equal(frames.size, 0);
  const f = fixture(); f.frame(0);
  const toggle = f.value.togglePlay; toggle(); toggle(); toggle();
  assert.equal(frames.size, 2, "Only the active simulation frame and latest focus request may remain");
  hooks.unmount(); assert.equal(frames.size, 0);
});


test("new casts wait through flight and soaking without accepting input; saved waits follow the same server bite time", () => {
  const attempt = { ...challenge(), biteAt: new Date(at + 4000).toISOString(), fishRarity: "rare" };
  const f = fixture({ challenge: attempt }); f.frame(0);
  assert.equal(f.value.castStage, "casting"); f.value.togglePlay(); f.frame(1199);
  assert.equal(f.value.playing, false); assert.equal(f.value.reel.tick, 0);
  f.frame(1); assert.equal(f.value.castStage, "soaking");
  f.value.togglePlay(); f.frame(2799); assert.equal(f.value.playing, false);
  assert.equal(f.value.reel.tick, 0); assert.equal(f.value.castStage, "soaking");
  f.frame(1); assert.equal(f.value.castStage, "bite"); assert.equal(f.value.playing, false);
  f.value.togglePlay(); f.frame(0); f.frame(50); assert.equal(f.value.reel.tick, 1);
  hooks.unmount();
  const reopened = fixture({ challenge: attempt, now: at + 4200 }); reopened.frame(0);
  assert.equal(reopened.value.castStage, "bite"); assert.equal(reopened.value.playing, false);
  assert.equal(reopened.value.reel.tick, 1);
});

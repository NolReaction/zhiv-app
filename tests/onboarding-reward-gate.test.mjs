import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:onboarding-rewards-hooks";
const vite = await createServer({
  appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{
    name: "onboarding-rewards-hooks", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots = [], cursor = 0, effects = [], controller;
      export function reset(value) { slots = []; controller = value; }
      export function render(value) { cursor = 0; effects = []; controller = value; }
      export function flush() { const current = effects; effects = []; for (const effect of current) effect(); }
      export function useEffect(effect) { effects.push(effect); }
      export function useRef(value) { const index = cursor++; return slots[index] ??= {current: value}; }
      export function useGameRewards() { return controller; }
    `; },
    transform(source, id) {
      if (id.endsWith("/features/game/daily-rewards.tsx")) return source
        .replace('from "react";', `from "${hookModule}";`)
        .replace('from "./use-game-rewards";', `from "${hookModule}";`);
    },
  }],
});
after(() => vite.close());

const { ONBOARDING_REWARD_DELAY_MS, getWorldRewardPromptGate, createWorldRewardPromptGateStore, createWorldRewardSurfaceStore } = await vite.ssrLoadModule("/features/world/state/onboarding-reward-gate.ts");
const { createDailyRewardEntryPrompt } = await vite.ssrLoadModule("/features/game/daily-reward-entry.ts");
const { DailyRewardsDialog, DailyRewardsPanel } = await vite.ssrLoadModule("/features/game/daily-rewards.tsx");
const hooks = await vite.ssrLoadModule(hookModule);
const now = Date.parse("2026-10-08T12:00:00Z");
const terminal = (finishedAt = now, status = "completed") => ({ loaded: true, progress: { status, ...(finishedAt === null ? {} : { finishedAt }) } });

test("new, unhydrated and unfinished guides suppress daily invitations, including a paused guide", () => {
  for (const onboarding of [{ loaded: false, progress: null }, { loaded: false, progress: { status: "completed" } },
    { loaded: true, progress: null }, { loaded: true, progress: { status: "started" } },
    { loaded: true, progress: { status: "started" }, isPaused: true }]) {
    assert.deepEqual(getWorldRewardPromptGate(onboarding, now), { allowed: false, nextCheckAt: null });
  }
});

test("completion and explicit skip both wait a full minute", () => {
  assert.equal(ONBOARDING_REWARD_DELAY_MS, 60_000);
  for (const status of ["completed", "skipped"]) {
    const state = terminal(now, status);
    assert.deepEqual(getWorldRewardPromptGate(state, now), { allowed: false, nextCheckAt: now + 60_000 });
    assert.equal(getWorldRewardPromptGate(state, now + 59_999).allowed, false);
    assert.deepEqual(getWorldRewardPromptGate(state, now + 60_000), { allowed: true, nextCheckAt: null });
  }
});

test("epoch zero is a valid saved completion time, not a legacy missing timestamp", () => {
  assert.deepEqual(getWorldRewardPromptGate(terminal(0), 0), { allowed: false, nextCheckAt: 60_000 });
  assert.deepEqual(getWorldRewardPromptGate(terminal(0), 60_000), { allowed: true, nextCheckAt: null });
});

test("persisted finish preserves the remaining time after reload or leaving the world", () => {
  const reopened = JSON.parse(JSON.stringify(terminal()));
  assert.deepEqual(getWorldRewardPromptGate(reopened, now + 25_000), { allowed: false, nextCheckAt: now + 60_000 });
  assert.deepEqual(getWorldRewardPromptGate(reopened, now + 90_000), { allowed: true, nextCheckAt: null });
});

test("busy UI delays an already due invitation without starting a new minute", () => {
  assert.deepEqual(getWorldRewardPromptGate(terminal(), now + 70_000, true), { allowed: false, nextCheckAt: null });
  assert.deepEqual(getWorldRewardPromptGate(terminal(), now + 70_001, false), { allowed: true, nextCheckAt: null });
});

test("legacy terminal choices retain ordinary gift behavior without introducing a fresh tutorial delay", () => {
  for (const status of ["completed", "skipped"]) {
    assert.equal(getWorldRewardPromptGate(terminal(null, status), now).allowed, true);
    assert.equal(getWorldRewardPromptGate(terminal(null, status), now, true).allowed, false);
  }
});

function runtime(start = now) {
  let clock = start, serial = 0;
  const timers = new Map(), wakes = new Set(), scheduled = [];
  return {
    timers, wakes, scheduled,
    now: () => clock,
    schedule(callback, delayMs) { const id = ++serial; timers.set(id, callback); scheduled.push(delayMs); return id; },
    cancel(id) { timers.delete(id); },
    onWake(callback) { wakes.add(callback); return () => wakes.delete(callback); },
    setClock(value) { clock = value; },
    fire() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    wake() { for (const callback of wakes) callback(); },
  };
}

test("the timer schedules one deadline instead of polling, then grants readiness once", () => {
  const clock = runtime(), store = createWorldRewardPromptGateStore("PLAYER", terminal(), clock);
  let changes = 0;
  assert.equal(store.getSnapshot(), false); assert.equal(store.getServerSnapshot(), false);
  const stop = store.subscribe(() => changes++);
  assert.deepEqual(clock.scheduled, [60_000]);
  clock.setClock(now + 30_000); clock.wake();
  assert.equal(store.getSnapshot(), false); assert.deepEqual(clock.scheduled, [60_000]);
  clock.setClock(now + 60_000); clock.fire();
  assert.equal(store.getSnapshot(), true); assert.equal(changes, 1);
  clock.wake(); assert.equal(changes, 1); assert.equal(clock.timers.size, 0);
  stop(); assert.equal(clock.wakes.size, 0);
});

test("a foreground wake after throttled background time releases the elapsed deadline", () => {
  const clock = runtime(), store = createWorldRewardPromptGateStore("PLAYER", terminal(), clock);
  const stop = store.subscribe(() => {});
  clock.setClock(now + 120_000); clock.wake();
  assert.equal(store.getSnapshot(), true); assert.equal(clock.timers.size, 0);
  stop();
});

test("future finish and a backwards clock are bounded to one elapsed minute", () => {
  const future = terminal(now + 86_400_000);
  assert.deepEqual(getWorldRewardPromptGate(future, now), { allowed: false, nextCheckAt: now + 60_000 });
  const clock = runtime(), store = createWorldRewardPromptGateStore("PLAYER", future, clock);
  const stop = store.subscribe(() => {});
  clock.setClock(now - 86_400_000); clock.fire();
  assert.equal(store.getSnapshot(), true);
  assert.deepEqual(clock.scheduled, [60_000]);
  stop();
});

test("unmount cancels pending work and an old owner cannot notify the next account", () => {
  const clock = runtime(), first = createWorldRewardPromptGateStore("FIRST", terminal(), clock);
  let firstChanges = 0;
  const stop = first.subscribe(() => firstChanges++);
  const queued = [...clock.timers.values()][0];
  stop(); assert.equal(clock.timers.size, 0); assert.equal(clock.wakes.size, 0);
  const second = createWorldRewardPromptGateStore("SECOND", { loaded: true, progress: null }, clock);
  const stopSecond = second.subscribe(() => {});
  clock.setClock(now + 120_000); queued();
  assert.equal(firstChanges, 0); assert.equal(second.getSnapshot(), false);
  stopSecond();
});

test("resubscribing preserves a pending deadline and old players need no timer", () => {
  const clock = runtime(), store = createWorldRewardPromptGateStore("PLAYER", terminal(), clock);
  const first = store.subscribe(() => {}); first();
  clock.setClock(now + 25_000);
  const second = store.subscribe(() => {});
  assert.deepEqual(clock.scheduled, [60_000, 35_000]);
  second();
  const legacyClock = runtime(), legacy = createWorldRewardPromptGateStore("LEGACY", terminal(null), legacyClock);
  const stopLegacy = legacy.subscribe(() => {});
  assert.equal(legacy.getSnapshot(), true); assert.deepEqual(legacyClock.scheduled, []);
  stopLegacy();
});

test("a foreground modal holds a ready invitation until the underlying map becomes interactive again", () => {
  const names = ["document", "MutationObserver"];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let covered = false, callback, disconnected = false, notifications = 0;
  const element = { isConnected: true, closest: selector => {
    assert.equal(selector, '[aria-hidden="true"], [inert], [hidden]');
    return covered ? {} : null;
  } };
  const ref = { current: null };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { body: {} } });
  Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: class {
    constructor(listener) { callback = listener; }
    observe(target, options) { assert.equal(target, document.body); assert.equal(options.subtree, true); }
    disconnect() { disconnected = true; }
  } });
  try {
    const surface = createWorldRewardSurfaceStore(ref);
    assert.equal(surface.getSnapshot(), true, "a missing surface never triggers an early popup");
    const stop = surface.subscribe(() => notifications++);
    ref.current = element; callback();
    assert.equal(surface.getSnapshot(), false, "the outer map dialog itself does not cover the map");
    const timerClock = runtime(now + 60_000);
    const timer = createWorldRewardPromptGateStore("PLAYER", terminal(), timerClock);
    const stopTimer = timer.subscribe(() => {});
    assert.equal(timer.getSnapshot() && !surface.getSnapshot(), true);
    covered = true; callback();
    assert.equal(timer.getSnapshot() && !surface.getSnapshot(), false, "audio or any other modal holds the ready invitation");
    covered = false; callback();
    assert.equal(timer.getSnapshot() && !surface.getSnapshot(), true, "closing the modal reuses the already elapsed deadline");
    element.isConnected = false; callback();
    assert.equal(surface.getSnapshot(), true);
    assert.equal(notifications, 4);
    stop(); stopTimer(); assert.equal(disconnected, true);
  } finally {
    for (const name of names) {
      const descriptor = originals.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
});

const rewardState = () => ({ data: { ownerPublicId: "PLAYER", daily: { claimable: true, reward: { coins: 1, pearls: 0, items: {} }, cycle: [] } },
  readVersion: 2, loading: false, busy: false, pending: null, uncertain: false, result: null, retryAt: 0, now,
  refresh() {}, claimDaily() {}, retry() {} });

test("deferral does not consume the one-per-visit prompt or require another server read", () => {
  const prompt = createDailyRewardEntryPrompt("PLAYER", 1), state = rewardState();
  for (let i = 0; i < 3; i++) assert.equal(prompt.shouldOpen(state, true, false), false);
  assert.equal(prompt.shouldOpen(state, true, true), true);
  assert.equal(prompt.shouldOpen(state, true, true), false);
});

test("uncertain daily receipt recovery also waits automatically, with manual dismissal respected", () => {
  const state = { ...rewardState(), uncertain: true, pending: { kind: "daily" } };
  const prompt = createDailyRewardEntryPrompt("PLAYER", 1);
  assert.equal(prompt.shouldOpen(state, true, false), false);
  assert.equal(prompt.shouldOpen(state, true, true), true);
  const manual = createDailyRewardEntryPrompt("PLAYER", 1);
  manual.dismiss();
  assert.equal(manual.shouldOpen(state, true, true), false);
});

function dialog() {
  const controller = rewardState(), calls = [];
  controller.readVersion = 1;
  hooks.reset(controller);
  const render = (open = false, autoPromptAllowed = false) => {
    hooks.render(controller);
    const tree = DailyRewardsDialog({ ownerPublicId: "PLAYER", economy: { snapshot: null, refresh() {} },
      open, autoPromptAllowed, onOpenChange: value => calls.push(value), onReturnFocus() {} });
    hooks.flush(); return tree;
  };
  return { controller, calls, render };
}

test("dialog honors the gate and reevaluates when it becomes allowed", () => {
  const app = dialog(); app.render();
  app.controller.readVersion++;
  app.render(false, false); assert.deepEqual(app.calls, []);
  app.render(false, true); assert.deepEqual(app.calls, [true]);
  app.render(false, true); assert.deepEqual(app.calls, [true]);
});

test("manual opening and claiming work during deferral and prevent a second automatic interruption", () => {
  const app = dialog(); app.render(); app.controller.readVersion++;
  let claims = 0; app.controller.claimDaily = () => claims++;
  const tree = app.render(true, false);
  assert.equal(tree.props.open, true); assert.deepEqual(app.calls, []);
  const elements = node => {
    if (!isValidElement(node)) return [];
    return [node, ...Children.toArray(node.props.children).flatMap(elements)];
  };
  const panel = elements(tree).find(node => node.type === DailyRewardsPanel);
  const button = elements(DailyRewardsPanel(panel.props)).find(node => node.type === "button"
    && Children.toArray(node.props.children).includes("Забрать подарок"));
  assert.ok(button); assert.equal(button.props.disabled, false);
  button.props.onClick(); assert.equal(claims, 1);
  app.render(false, true); assert.deepEqual(app.calls, []);
});

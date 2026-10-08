import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:world-onboarding-ui-hooks";
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{
    name: "world-onboarding-ui-hooks",
    enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) {
      if (id === `\0${hookModule}`) return `
        let slots = [], cursor = 0, effects = [], runEffects = false, observation = null;
        export function reset() { slots = []; cursor = 0; effects = []; runEffects = false; observation = null; }
        export function render() { cursor = 0; effects = []; }
        export function enableEffects() { runEffects = true; }
        export function flush() { const pending = effects; effects = []; for (const effect of pending) effect(); }
        export function dispose() { for (const slot of slots) slot.current?.cleanup?.(); }
        export function setObservation(value) { observation = value; }
        export function useForestObservation() { return observation; }
        export function useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; }
        export function useState(initial) {
          const index = cursor++;
          const slot = slots[index] ??= { current: typeof initial === 'function' ? initial() : initial };
          return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value; }];
        }
        export function useEffect(effect, dependencies) {
          const previous = useRef(null);
          if (runEffects && (!previous.current || dependencies.some((value, index) => !Object.is(value, previous.current.dependencies[index])))) {
            effects.push(() => { previous.current?.cleanup?.(); previous.current = { dependencies, cleanup: effect() }; });
          }
        }
      `;
    },
    transform(source, id) {
      if (id.endsWith("/features/world/ui/onboarding/world-onboarding.tsx")) {
        return source.replace('from "react";', `from "${hookModule}";`)
          .replace('from "@/features/world/state/use-forest-observation";', `from "${hookModule}";`);
      }
    },
  }],
});
after(() => vite.close());

const {
  WORLD_ONBOARDING_VERSION,
  WORLD_ONBOARDING_STEPS,
  parseWorldOnboarding,
} = await vite.ssrLoadModule("/features/world/domain/world-onboarding.ts");
const {
  createWorldOnboardingStore,
  onboardingStorageKey,
  readWorldOnboarding,
  writeWorldOnboarding,
} = await vite.ssrLoadModule("/features/world/state/world-onboarding-storage.ts");
const hooks = await vite.ssrLoadModule(hookModule);
const { WorldOnboarding, WorldOnboardingSession } = await vite.ssrLoadModule("/features/world/ui/onboarding/world-onboarding.tsx");
const { WorldHelp } = await vite.ssrLoadModule("/features/world/ui/help/world-help.tsx");

const stepIds = ["clearing", "profile", "pantry", "expeditions", "help"];
const started = stepId => ({ version: WORLD_ONBOARDING_VERSION, status: "started", stepId });
const terminal = status => ({ version: WORLD_ONBOARDING_VERSION, status });

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
}

function elements(tree) {
  const result = [];
  const walk = node => {
    if (!isValidElement(node)) return;
    result.push(node);
    Children.forEach(node.props.children, walk);
  };
  walk(tree);
  return result;
}
const text = node => renderToStaticMarkup(node).replace(/<[^>]*>/g, "");
const button = (nodes, label) => nodes.find(node => node.type === "button"
  && (node.props["aria-label"] === label || text(node) === label));
function guide(progress = null, overrides = {}) {
  hooks.reset();
  const calls = [];
  const props = {
    open: true,
    progress,
    worldElement: { current: null },
    onStart: () => calls.push(["start"]),
    onStep: stepId => calls.push(["step", stepId]),
    onSkip: () => calls.push(["skip"]),
    onComplete: () => calls.push(["complete"]),
    onPause: () => calls.push(["pause"]),
    onReturnFocus: () => calls.push(["return-focus"]),
    ...overrides,
  };
  const tree = WorldOnboarding(props);
  return { tree, nodes: elements(tree), calls };
}

function sessionGuide(observation = null) {
  const globals = ["requestAnimationFrame", "cancelAnimationFrame", "MutationObserver"];
  const original = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const frames = new Map(), observers = [];
  let nextFrame = 0, ready = false, unrelatedReady = false, focusReturns = 0;
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value(callback) {
    const id = ++nextFrame; frames.set(id, callback); return id;
  } });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value(id) { frames.delete(id); } });
  Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: class {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
  } });
  const element = { querySelector(selector) {
    if (selector === '[data-ready="true"] > canvas[role="img"]') return ready ? {} : null;
    if (selector === '[data-ready="true"]') return ready || unrelatedReady ? {} : null;
    assert.fail(`unknown scene readiness selector ${selector}`);
  } };
  const props = {
    open: true, progress: started("pantry"), worldElement: { current: element }, presenceKey: "session-guide-player",
    onStart() {}, onStep() {}, onSkip() {}, onComplete() {}, onPause() {}, onReturnFocus() { focusReturns++; },
  };
  hooks.reset(); hooks.enableEffects(); hooks.setObservation(observation);
  return {
    props, element, observers, frames,
    get focusReturns() { return focusReturns; },
    render() { hooks.render(); const tree = WorldOnboardingSession(props); hooks.flush(); return tree; },
    setReady(value) { ready = value; },
    setUnrelatedReady(value) { unrelatedReady = value; },
    mutate() { for (const observer of observers) if (!observer.disconnected) observer.callback([]); },
    frame() { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } },
    observation(value) { hooks.setObservation(value); },
    dispose() {
      hooks.dispose();
      for (const name of globals) {
        const descriptor = original.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
      }
    },
  };
}

test("the versioned introduction keeps five ordered, immutable steps", () => {
  assert.equal(WORLD_ONBOARDING_VERSION, 1);
  assert.deepEqual(WORLD_ONBOARDING_STEPS.map(step => step.id), stepIds);
  assert.equal(new Set(WORLD_ONBOARDING_STEPS.map(step => step.id)).size, stepIds.length);
  assert.ok(Object.isFrozen(WORLD_ONBOARDING_STEPS), "the shared sequence cannot change during a player's introduction");
  assert.ok(WORLD_ONBOARDING_STEPS.every(Object.isFrozen), "a shared step cannot be edited during a player's introduction");
});

test("every saved step resumes at the same place", () => {
  for (const stepId of stepIds) {
    const progress = started(stepId);
    assert.deepEqual(parseWorldOnboarding(JSON.stringify(progress)), progress);
  }
});

test("skipping and completing are distinct terminal decisions", () => {
  for (const status of ["skipped", "completed"]) {
    const progress = terminal(status);
    assert.deepEqual(parseWorldOnboarding(JSON.stringify(progress)), progress);
    assert.deepEqual(parseWorldOnboarding(JSON.stringify({ ...progress, stepId: "pantry", futureField: true })), progress,
      "terminal decisions never resume an old step");
  }
});

test("missing, malformed and non-object data shows a fresh introduction", () => {
  for (const raw of [null, "", "{", "undefined", "null", "true", "0", '"started"', "[]", "[{}]"]) {
    assert.equal(parseWorldOnboarding(raw), null, `unexpectedly accepted ${String(raw)}`);
  }
});

test("unknown versions, decisions and step IDs cannot dismiss or misdirect the introduction", () => {
  const invalid = [
    {},
    { status: "completed" },
    { version: 0, status: "completed" },
    { version: 2, status: "skipped" },
    { version: "1", status: "completed" },
    { version: null, status: "completed" },
    { version: 1 },
    { version: 1, status: "pending" },
    { version: 1, status: "STARTED", stepId: "clearing" },
    { version: 1, status: "started" },
    { version: 1, status: "started", stepId: "buildings" },
    { version: 1, status: "started", stepId: "" },
    { version: 1, status: "started", stepId: null },
    { version: 1, status: "started", stepId: 0 },
    { version: 1, status: "started", stepId: ["clearing"] },
  ];
  for (const value of invalid) {
    assert.equal(parseWorldOnboarding(JSON.stringify(value)), null, `unexpectedly accepted ${JSON.stringify(value)}`);
  }
});

test("local progress uses a stable versioned key for each account", () => {
  assert.equal(onboardingStorageKey("FIRST-PLAYER"), "zhiv.world-onboarding.v1:FIRST-PLAYER");
  assert.equal(onboardingStorageKey("SECOND-PLAYER"), "zhiv.world-onboarding.v1:SECOND-PLAYER");
  assert.notEqual(onboardingStorageKey("FIRST-PLAYER"), onboardingStorageKey("SECOND-PLAYER"));
});

test("one player's skip cannot hide another player's guide or overwrite its resume step", () => {
  const storage = memoryStorage();
  assert.equal(readWorldOnboarding("FIRST-PLAYER", storage), null);
  assert.equal(writeWorldOnboarding("FIRST-PLAYER", terminal("skipped"), storage), true);
  assert.equal(readWorldOnboarding("SECOND-PLAYER", storage), null);
  assert.equal(writeWorldOnboarding("SECOND-PLAYER", started("pantry"), storage), true);
  assert.deepEqual(readWorldOnboarding("FIRST-PLAYER", storage), terminal("skipped"));
  assert.deepEqual(readWorldOnboarding("SECOND-PLAYER", storage), started("pantry"));
  assert.equal(storage.values.size, 2);
});

test("saved progress survives reopening and can become completed without retaining an old step", () => {
  const storage = memoryStorage();
  assert.equal(writeWorldOnboarding("PLAYER", started("expeditions"), storage), true);
  const reopened = { getItem: key => storage.values.get(key) ?? null };
  assert.deepEqual(readWorldOnboarding("PLAYER", reopened), started("expeditions"));
  assert.equal(writeWorldOnboarding("PLAYER", terminal("completed"), storage), true);
  assert.deepEqual(readWorldOnboarding("PLAYER", reopened), terminal("completed"));
  assert.deepEqual(JSON.parse(storage.values.get(onboardingStorageKey("PLAYER"))), terminal("completed"));
});

test("unreadable and future local progress is treated as absent without rewriting storage", () => {
  const storage = memoryStorage();
  for (const raw of ["{", JSON.stringify({ version: 2, status: "completed" }), JSON.stringify(started("unknown"))]) {
    storage.values.set(onboardingStorageKey("PLAYER"), raw);
    assert.equal(readWorldOnboarding("PLAYER", storage), null);
    assert.equal(storage.values.get(onboardingStorageKey("PLAYER")), raw);
  }
});

test("blocked browser storage does not prevent showing or closing the guide", () => {
  const denied = {
    getItem() { throw new Error("Storage access denied"); },
    setItem() { throw new Error("Storage quota exceeded"); },
  };
  assert.equal(readWorldOnboarding("PLAYER", denied), null);
  assert.equal(writeWorldOnboarding("PLAYER", started("clearing"), denied), false);
  assert.equal(writeWorldOnboarding("PLAYER", terminal("skipped"), denied), false);
  assert.equal(writeWorldOnboarding("PLAYER", terminal("completed"), denied), false);
});

test("the account store hydrates deliberately and notifies only its active subscribers", () => {
  const storage = memoryStorage();
  writeWorldOnboarding("STORE-PLAYER", started("profile"), storage);
  const store = createWorldOnboardingStore("STORE-PLAYER", storage);
  assert.deepEqual(store.getServerSnapshot(), { loaded: false, progress: null });
  assert.deepEqual(store.getSnapshot(), { loaded: false, progress: null });
  assert.equal(store.getSnapshot(), store.getSnapshot(), "external-store reads keep a stable snapshot before changes");
  assert.equal(store.getServerSnapshot(), store.getServerSnapshot(), "SSR reads keep a stable snapshot");
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  store.restore();
  assert.deepEqual(store.getSnapshot(), { loaded: true, progress: started("profile") });
  assert.equal(store.getSnapshot(), store.getSnapshot(), "restored external-store reads do not cause a render loop");
  assert.ok(notifications > 0, "restored state must reach the client hook");
  store.save(started("pantry"));
  assert.deepEqual(store.getSnapshot(), { loaded: true, progress: started("pantry") });
  assert.deepEqual(readWorldOnboarding("STORE-PLAYER", storage), started("pantry"));
  const subscribedNotifications = notifications;
  unsubscribe();
  store.save(terminal("completed"));
  assert.equal(notifications, subscribedNotifications, "an unmounted owner no longer receives updates");
  assert.deepEqual(store.getServerSnapshot(), { loaded: false, progress: null }, "server markup remains hydration-safe");
});

test("temporary storage failures keep the guide usable and remember the current account in memory", () => {
  const denied = {
    getItem() { throw new Error("Storage access denied"); },
    setItem() { throw new Error("Storage access denied"); },
  };
  const first = createWorldOnboardingStore("IN-MEMORY-FIRST", denied);
  first.restore();
  assert.deepEqual(first.getSnapshot(), { loaded: true, progress: null });
  first.save(started("expeditions"));
  assert.deepEqual(first.getSnapshot(), { loaded: true, progress: started("expeditions") });
  const reopened = createWorldOnboardingStore("IN-MEMORY-FIRST", denied);
  reopened.restore();
  assert.deepEqual(reopened.getSnapshot(), { loaded: true, progress: started("expeditions") });
  const other = createWorldOnboardingStore("IN-MEMORY-SECOND", denied);
  other.restore();
  assert.deepEqual(other.getSnapshot(), { loaded: true, progress: null });
  reopened.save(terminal("skipped"));
  const afterSkip = createWorldOnboardingStore("IN-MEMORY-FIRST", denied);
  afterSkip.restore();
  assert.deepEqual(afterSkip.getSnapshot(), { loaded: true, progress: terminal("skipped") });
  assert.deepEqual(other.getSnapshot(), { loaded: true, progress: null });
});

test("the welcome screen explains the small guide and waits for an explicit start or skip", () => {
  const view = guide();
  assert.equal(view.tree.props.open, true);
  assert.ok(view.nodes.some(node => node.props["data-world-onboarding"] === "welcome"));
  assert.ok(view.nodes.some(node => node.props.children === "Привет! Я Мохлик."));
  assert.ok(view.nodes.some(node => typeof node.props.children === "string" && /Пять коротких подсказок/.test(node.props.children)));
  assert.ok(view.nodes.some(node => typeof node.props.children === "string" && /«Ещё» → «Обучение»/.test(node.props.children)));
  assert.equal(button(view.nodes, "Предыдущая подсказка"), undefined);
  assert.deepEqual(view.calls, [], "opening the invitation never starts or dismisses the guide on behalf of the player");
  button(view.nodes, "Пройти обучение").props.onClick();
  assert.deepEqual(view.calls, [["start"]]);

  const skipped = guide();
  button(skipped.nodes, "Пропустить").props.onClick();
  assert.deepEqual(skipped.calls, [["skip"]]);
});

test("each saved step renders its explanation and offers the correct forward and back actions", () => {
  for (const [index, step] of WORLD_ONBOARDING_STEPS.entries()) {
    const view = guide(started(step.id));
    assert.ok(view.nodes.some(node => node.props["data-world-onboarding"] === step.id));
    assert.ok(view.nodes.some(node => node.props.children === step.title));
    assert.ok(view.nodes.some(node => node.props.children === step.text));
    assert.ok(view.nodes.some(node => node.props.children === step.hint));
    assert.ok(view.nodes.some(node => node.props["aria-label"] === `Шаг ${index + 1} из ${stepIds.length}`));
    assert.deepEqual(view.calls, [], "rendering a saved step is read-only");
    if (index > 0) {
      button(view.nodes, "Предыдущая подсказка").props.onClick();
      assert.deepEqual(view.calls, [["step", stepIds[index - 1]]]);
    } else assert.equal(button(view.nodes, "Предыдущая подсказка"), undefined);
    const forward = guide(started(step.id));
    button(forward.nodes, index === stepIds.length - 1 ? "Начать играть" : "Дальше").props.onClick();
    assert.deepEqual(forward.calls, index === stepIds.length - 1 ? [["complete"]] : [["step", stepIds[index + 1]]]);
  }
});

test("the whole guide advances through five steps and completes only after the final click", () => {
  let progress = null;
  const visited = [], callbacks = {
    onStart() { progress = started("clearing"); },
    onStep(stepId) { progress = started(stepId); },
    onComplete() { progress = terminal("completed"); },
  };
  button(guide(progress, callbacks).nodes, "Пройти обучение").props.onClick();
  for (const stepId of stepIds) {
    assert.deepEqual(progress, started(stepId));
    visited.push(progress.stepId);
    const view = guide(progress, callbacks);
    button(view.nodes, stepId === "help" ? "Начать играть" : "Дальше").props.onClick();
  }
  assert.deepEqual(visited, stepIds);
  assert.deepEqual(progress, terminal("completed"));
});

test("any explanation can be skipped or paused without marking the guide completed", () => {
  for (const stepId of stepIds) {
    const progress = started(stepId), before = structuredClone(progress);
    const skipped = guide(progress);
    button(skipped.nodes, "Пропустить обучение").props.onClick();
    assert.deepEqual(skipped.calls, [["skip"]]);
    const paused = guide(progress);
    button(paused.nodes, "Закрыть обучение").props.onClick();
    assert.deepEqual(paused.calls, [["pause"]]);
    assert.deepEqual(progress, before, "UI actions delegate progress instead of mutating a saved object");
  }
});

test("outside clicks preserve the guide, Escape pauses it, and closing returns keyboard focus", () => {
  const view = guide(started("pantry"));
  const content = view.nodes.find(node => node.props["data-world-onboarding"] === "pantry");
  let prevented = 0, stopped = 0;
  const event = { preventDefault() { prevented++; }, stopPropagation() { stopped++; } };
  content.props.onPointerDownOutside(event);
  content.props.onInteractOutside(event);
  assert.equal(prevented, 2);
  assert.deepEqual(view.calls, [], "an outside click cannot silently skip the player");
  content.props.onEscapeKeyDown(event);
  assert.equal(prevented, 3);
  assert.equal(stopped, 1);
  assert.deepEqual(view.calls, [["pause"]]);
  content.props.onCloseAutoFocus(event);
  assert.equal(prevented, 4);
  assert.deepEqual(view.calls, [["pause"], ["return-focus"]]);
  const dismissed = guide();
  dismissed.tree.props.onOpenChange(false);
  assert.deepEqual(dismissed.calls, [["pause"]]);
});

test("the help index offers an explicit tutorial replay when a replay callback is available", () => {
  function help(props = {}) {
    let tree;
    function Probe() { tree = WorldHelp(props); return null; }
    renderToStaticMarkup(createElement(Probe));
    return elements(tree);
  }
  assert.equal(button(help(), "Пройти обучение с Мохликом"), undefined);
  let replays = 0;
  const nodes = help({
    onReplayTutorial: () => replays++,
    onNavigate() { assert.fail("replaying the introduction does not select a game action"); },
  });
  assert.equal(replays, 0, "opening help cannot restart the guide");
  const replay = button(nodes, "Пройти обучение с Мохликом");
  assert.ok(replay);
  replay.props.onClick();
  assert.equal(replays, 1);
});

test("the session guide waits for the actual ready scene before opening the saved step", () => {
  const session = sessionGuide();
  try {
    const initial = session.render();
    assert.equal(initial.type, WorldOnboarding);
    assert.equal(initial.props.open, false, "a mounted world container does not imply a ready backdrop");
    assert.equal(initial.props.progress, session.props.progress);
    assert.equal(session.observers.length, 1);
    assert.equal(session.observers[0].target, session.element);
    assert.deepEqual(session.observers[0].options.attributeFilter, ["data-ready"]);
    session.setUnrelatedReady(true);
    session.frame();
    assert.equal(session.render().props.open, false, "another ready component is not a ready world canvas");
    session.setReady(true);
    session.mutate();
    const ready = session.render();
    assert.equal(ready.props.open, true);
    ready.props.onReturnFocus();
    assert.equal(session.focusReturns, 1, "a ready active scene receives its normal focus return");
    session.props.open = false;
    assert.equal(session.render().props.open, false, "readiness does not override the parent's dismissed or paused state");
  } finally { session.dispose(); }
});

test("initial animation-frame readiness and later scene loss both update the tutorial gate", () => {
  const session = sessionGuide();
  try {
    assert.equal(session.render().props.open, false);
    session.setReady(true);
    session.frame();
    assert.equal(session.render().props.open, true, "an already rendered backdrop is detected without a later DOM mutation");
    session.setReady(false);
    session.mutate();
    assert.equal(session.render().props.open, false, "a removed ready backdrop cannot leave an active tutorial modal");
  } finally { session.dispose(); }
  assert.ok(session.observers.every(observer => observer.disconnected), "unmounting disconnects scene mutation observers");
  assert.equal(session.frames.size, 0);
});

test("another-device ownership suppresses the tutorial and prevents returning focus under the takeover notice", () => {
  const session = sessionGuide({ memory: { sync: { mode: "other-device" } } });
  try {
    session.setReady(true);
    const pending = session.render();
    pending.props.onReturnFocus();
    assert.equal(session.focusReturns, 0);
    session.frame();
    const blocked = session.render();
    assert.equal(blocked.props.open, false, "scene readiness cannot cover the ownership warning with a tutorial modal");
    blocked.props.onReturnFocus();
    assert.equal(session.focusReturns, 0, "closing a suppressed modal cannot steal focus from the takeover notice");
    session.observation(null);
    const active = session.render();
    assert.equal(active.props.open, true, "restored ownership permits the saved tutorial without a new choice");
    active.props.onReturnFocus();
    assert.equal(session.focusReturns, 1);
  } finally { session.dispose(); }
});

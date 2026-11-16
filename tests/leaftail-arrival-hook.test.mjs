import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { compactVillagerFixture } from "./helpers/new-map-scene.mjs";

const root = fileURLToPath(new URL("..", import.meta.url)), virtual = "virtual:leaftail-arrival-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "arrival-hook-lifecycle", enforce: "pre",
    resolveId(id) { if (id === virtual) return `\0${id}`; },
    load(id) { if (id === `\0${virtual}`) return `
      let slots = [], cursor = 0, effects = [], cleanup = [];
      export function reset() { cleanup.forEach(fn => fn()); slots = []; cursor = 0; effects = []; cleanup = []; }
      export function render() { cursor = 0; }
      export function useMemo(make, dependencies) {
        const index = cursor++, previous = slots[index];
        if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i])))
          slots[index] = { value: make(), dependencies };
        return slots[index].value;
      }
      export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial;
        return [slots[index], value => { slots[index] = value; }]; }
      export function useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; }
      export function useLayoutEffect(callback, dependencies) {
        const index = cursor++, previous = slots[index];
        if (!previous || dependencies.some((value, i) => !Object.is(value, previous[i]))) {
          slots[index] = dependencies; effects.push(() => { const result = callback(); if (result) cleanup.push(result); });
        }
      }
      export const useEffect = useLayoutEffect;
      export function useCallback(callback, dependencies) { return useMemo(() => callback, dependencies); }
      export function useSyncExternalStore(subscribe, getSnapshot) {
        useMemo(() => { cleanup.push(subscribe(() => {})); return null; }, [subscribe]);
        return getSnapshot();
      }
      export function flushEffects() { const pending = effects; effects = []; pending.forEach(callback => callback()); }
    `; },
    transform(source, id) { if (id.endsWith("/features/world/state/use-resident-arrival.ts"))
      return source.replace('from "react";', `from "${virtual}";`); },
  }] });
after(() => vite.close());
const hooks = await vite.ssrLoadModule(virtual);
const { useLeaftailArrival } = await vite.ssrLoadModule("/features/world/state/use-leaftail-arrival.ts");
const { useMinerArrival } = await vite.ssrLoadModule("/features/world/state/use-miner-arrival.ts");
const { useLopukhArrival } = await vite.ssrLoadModule("/features/world/state/use-lopukh-arrival.ts");
const { createForestVillagers, configureForestVillagers, advanceForestVillagers } = await vite.ssrLoadModule("/features/world/characters/villagers/villager-mind.ts");
const opts = { unlocked: true, enabled: true, onboarding: { loaded: true, isPaused: false, progress: { version: 2, status: "completed" } } };
function browser(run, useArrival = useLeaftailArrival) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window"), originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document"),
    data = new Map(), listeners = new Map(), documentListeners = new Map();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) },
    addEventListener(type, callback) { listeners.set(callback, type); }, removeEventListener(_type, callback) { listeners.delete(callback); },
  } });
  const document = { visibilityState: "visible", addEventListener(type, callback) { documentListeners.set(callback, type); },
    removeEventListener(_type, callback) { documentListeners.delete(callback); } };
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  function useArrivalRender(owner, options = opts) { hooks.render(); const value = useArrival(owner, options); hooks.flushEffects(); return value; }
  function renderMany(entries) {
    hooks.render(); const values = entries.map(([owner, options = opts]) => useArrival(owner, options)); hooks.flushEffects(); return values;
  }
  hooks.reset();
  try { run({ render: useArrivalRender, renderMany, data,
    hide() { document.visibilityState = "hidden"; for (const [callback, type] of documentListeners) if (type === "visibilitychange") callback(); },
    pagehide() { for (const [callback, type] of listeners) if (type === "pagehide") callback(); } }); }
  finally { hooks.reset(); if (original) Object.defineProperty(globalThis, "window", original); else delete globalThis.window;
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else delete globalThis.document; }
}

test("closing the sailing coach still permits one completion message, while reload restores its dismissal", () => browser(({ render }) => {
  render("hook-arrival-one"); let value = render("hook-arrival-one");
  assert.equal(value.open, true); value.dismiss(); value = render("hook-arrival-one");
  assert.equal(value.open, false); assert.equal(value.seen, false); assert.equal(value.enabled, true);
  value.complete(); value = render("hook-arrival-one");
  assert.equal(value.seen, true); assert.equal(value.open, false); assert.equal(value.completionNotice, true); assert.equal(value.enabled, false);
  value.dismissCompletion(); value = render("hook-arrival-one"); assert.equal(value.open, false); assert.equal(value.completionNotice, false);
  hooks.reset(); render("hook-arrival-one"); value = render("hook-arrival-one");
  assert.equal(value.seen, true); assert.equal(value.open, false, "restoring seen progress does not report a fresh return");
  assert.equal(value.completionNotice, false);
}));

test("late arrival callbacks and completion messages stay with the account that owned the boat", () => browser(({ render, data }) => {
  render("hook-arrival-old"); const old = render("hook-arrival-old"); old.dismiss();
  render("hook-arrival-new"); let current = render("hook-arrival-new");
  old.complete(); old.dismiss(); current = render("hook-arrival-new");
  assert.equal(current.seen, false); assert.equal(current.open, true);
  assert.equal(JSON.parse(data.get("zhiv.leaftail-arrival.v1:hook-arrival-old")).arrived, false);
  current.dismiss(); current.complete(); current = render("hook-arrival-new"); assert.equal(current.open, false); assert.equal(current.completionNotice, true);
  render("hook-arrival-third"); current = render("hook-arrival-third", { ...opts, enabled: false });
  assert.equal(current.open, false); assert.equal(current.seen, false);
}));

test("two mounted views share an arrival immediately while other owners and completion notices stay isolated", () => browser(({ renderMany }) => {
  const entries = [["hook-shared-arrival", opts], ["hook-shared-arrival", { ...opts, enabled: false, continueEnabled: true }], ["hook-shared-other", opts]];
  renderMany(entries); let [map, circle, other] = renderMany(entries);
  assert.equal(map.seen, false); assert.equal(circle.seen, false); assert.equal(other.seen, false);
  assert.equal(map.enabled, true); assert.equal(circle.enabled, false, "a passive peer cannot borrow the map's continuation permission");
  map.dismiss(); [map, circle, other] = renderMany(entries);
  const lateCircleCompletion = circle.complete;
  map.complete(); [map, circle, other] = renderMany(entries);
  assert.equal(map.seen, true); assert.equal(circle.seen, true, "same-tab peers update without a native storage event or remount");
  assert.equal(other.seen, false);
  assert.equal(map.completionNotice, true); assert.equal(circle.completionNotice, false);
  entries[1] = [entries[1][0], opts];
  lateCircleCompletion(); [map, circle] = renderMany(entries);
  assert.equal(circle.completionNotice, false, "a peer's late acknowledgement cannot create a second toast");
  map.dismissCompletion(); [map, circle] = renderMany(entries);
  assert.equal(map.completionNotice, false); assert.equal(circle.completionNotice, false);
}));

for (const [resident, useArrival] of [["leaftail", useLeaftailArrival], ["miner", useMinerArrival], ["lopukh", useLopukhArrival]]) {
  for (const interruption of ["section", "hidden", "pagehide"]) {
    test(`${resident}: ${interruption} interruption consumes the introduction once without a replay or welcome toast`, () => browser(({ render, hide, pagehide }) => {
      const owner = `${resident}-interrupted-${interruption}`, locked = { ...opts, confirmed: true, unlocked: false }, unlocked = { ...opts, confirmed: true };
      render(owner, locked); render(owner, locked); render(owner, locked);
      let value = render(owner, unlocked); assert.equal(value.enabled, true);
      if (interruption === "section") render(owner, { ...unlocked, enabled: false, suspended: true });
      else if (interruption === "hidden") hide(); else pagehide();
      value = render(owner, unlocked);
      assert.equal(value.seen, true); assert.equal(value.enabled, false); assert.equal(value.open, false);
      assert.equal(value.completionNotice, false);
      value.complete(); value = render(owner, unlocked); assert.equal(value.completionNotice, false);
      hooks.reset(); render(owner, unlocked); render(owner, unlocked); value = render(owner, unlocked);
      assert.equal(value.seen, true); assert.equal(value.enabled, false); assert.equal(value.open, false);
    }, useArrival));
  }

  test(`${resident}: an ordinary modal or busy command pauses the arrival without consuming it`, () => browser(({ render }) => {
    const owner = `${resident}-modal-pause`;
    render(owner); let value = render(owner); assert.equal(value.enabled, true);
    value = render(owner, { ...opts, enabled: false }); assert.equal(value.seen, false); assert.equal(value.enabled, false);
    value = render(owner); assert.equal(value.seen, false); assert.equal(value.enabled, true);
    value.complete(); value = render(owner); assert.equal(value.seen, true);
  }, useArrival));

  test(`${resident}: profile keeps a started arrival moving and defers its completion notice`, () => browser(({ render }) => {
    const owner = `${resident}-profile-running`, profile = { ...opts, enabled: false, continueEnabled: true };
    render(owner); let value = render(owner); value.dismiss();
    value = render(owner, profile);
    assert.equal(value.enabled, true); assert.equal(value.open, false); assert.equal(value.seen, false);
    value.complete(); value = render(owner, profile);
    assert.equal(value.seen, true); assert.equal(value.enabled, false); assert.equal(value.completionNotice, false);
    value = render(owner); assert.equal(value.completionNotice, true);
    value.dismissCompletion(); value = render(owner); assert.equal(value.completionNotice, false);
  }, useArrival));

  test(`${resident}: profile cannot begin an arrival or borrow continuation from another account`, () => browser(({ render }) => {
    const owner = `${resident}-profile-queued`, profile = { ...opts, enabled: false, continueEnabled: true };
    render(owner, profile); let value = render(owner, profile);
    assert.equal(value.enabled, false); assert.equal(value.open, false);
    value = render(owner); assert.equal(value.enabled, true);
    value = render(owner, profile); assert.equal(value.enabled, true);
    value = render(owner, { ...profile, continueEnabled: false });
    assert.equal(value.enabled, false); assert.equal(value.seen, false, "an in-flight command still pauses movement");
    value = render(owner, profile); assert.equal(value.enabled, true);
    render(`${owner}-other`, profile); value = render(`${owner}-other`, profile);
    assert.equal(value.enabled, false); assert.equal(value.open, false); assert.equal(value.seen, false);
  }, useArrival));

  test(`${resident}: hiding before the arrival is allowed does not consume a queued introduction`, () => browser(({ render, hide }) => {
    const owner = `${resident}-queued-hidden`, locked = { ...opts, confirmed: true, unlocked: false, enabled: false };
    render(owner, locked); render(owner, locked); render(owner, locked); hide();
    let value = render(owner, { ...locked, unlocked: true }); assert.equal(value.seen, false);
    value = render(owner, { ...locked, unlocked: true, enabled: true });
    assert.equal(value.enabled, true); assert.equal(value.seen, false);
  }, useArrival));

  test(`${resident}: an established confirmed world never replays historical arrivals on a new browser or reload`, () => browser(({ render, data }) => {
    const owner = `${resident}-existing-world`, options = { ...opts, confirmed: false, unlocked: false };
    render(owner, options); let value = render(owner, options);
    assert.equal(value.enabled, false); assert.equal(value.loaded, false, "cached building levels cannot start a cutscene");
    const confirmed = { ...opts, confirmed: true };
    value = render(owner, confirmed); assert.equal(value.enabled, false, "first confirmed snapshot is adopted before the scene can run");
    render(owner, confirmed); value = render(owner, confirmed);
    assert.equal(value.seen, true); assert.equal(value.enabled, false); assert.equal(value.open, false); assert.equal(value.completionNotice, false);
    assert.deepEqual(JSON.parse(data.get(`zhiv.${resident}-arrival.v1:${owner}`)), { version: 1, arrived: true, dismissed: true });
    hooks.reset(); render(owner, confirmed); render(owner, confirmed); value = render(owner, confirmed);
    assert.equal(value.seen, true); assert.equal(value.enabled, false); assert.equal(value.open, false);
  }, useArrival));

  test(`${resident}: a new unlock after the confirmed baseline still presents and completes once`, () => browser(({ render }) => {
    const owner = `${resident}-new-confirmed-unlock`, locked = { ...opts, confirmed: true, unlocked: false };
    render(owner, locked); render(owner, locked); let value = render(owner, locked);
    assert.equal(value.loaded, true); assert.equal(value.seen, false); assert.equal(value.enabled, false);
    const before = structuredClone(opts.onboarding);
    value = render(owner, { ...opts, confirmed: true });
    assert.equal(value.enabled, true); assert.equal(value.seen, false); assert.equal(value.open, true);
    value.complete(); value = render(owner, { ...opts, confirmed: true });
    assert.equal(value.seen, true); assert.equal(value.enabled, false);
    assert.deepEqual(opts.onboarding, before, "arrival leaves the replayable main tutorial unchanged");
  }, useArrival));

  test(`${resident}: historical arrival adoption is scoped to the confirmed account`, () => browser(({ render }) => {
    const options = { ...opts, confirmed: true };
    render(`${resident}-baseline-old`, options); render(`${resident}-baseline-old`, options);
    const old = render(`${resident}-baseline-old`, options);
    const owner = `${resident}-baseline-new`, locked = { ...options, unlocked: false };
    render(owner, locked); render(owner, locked); let value = render(owner, locked);
    old.complete(); old.dismiss(); value = render(owner, locked);
    assert.equal(value.seen, false); assert.equal(value.open, false);
    value = render(owner, options); assert.equal(value.enabled, true);
  }, useArrival));

  test(`${resident}: an open coach owns the arrival finale without a second notice`, () => browser(({ render }) => {
    const owner = `${resident}-open-coach`;
    render(owner); let value = render(owner);
    value.complete(); value = render(owner);
    assert.equal(value.open, true); assert.equal(value.seen, true); assert.equal(value.completionNotice, false);
    value.dismiss(); value.complete(); value = render(owner);
    assert.equal(value.open, false); assert.equal(value.completionNotice, false);
  }, useArrival));

  test(`${resident}: a queued completion waits for a free map and cannot replay after dismissal`, () => browser(({ render }) => {
    const owner = `${resident}-queued-notice`;
    render(owner); let value = render(owner); value.dismiss(); value.complete();
    value = render(owner, { ...opts, enabled: false });
    assert.equal(value.open, false); assert.equal(value.completionNotice, false); assert.equal(value.seen, true);
    value = render(owner, { ...opts, onboarding: { ...opts.onboarding, progress: { status: "started" } } });
    assert.equal(value.completionNotice, false, "a resumed tutorial takes precedence");
    value = render(owner); assert.equal(value.completionNotice, true);
    value.dismissCompletion(); value.complete(); value = render(owner);
    assert.equal(value.completionNotice, false, "late duplicate callbacks do not rearm the toast");
    value.complete(); value = render(owner); assert.equal(value.completionNotice, false);
  }, useArrival));

  test(`${resident}: restored completion from another tab and stale owner callbacks never produce a notice`, () => browser(({ render, data }) => {
    const owner = `${resident}-tab-complete`, other = `${resident}-next-owner`;
    render(owner); let value = render(owner); value.dismiss();
    const key = `zhiv.${resident}-arrival.v1:${owner}`;
    data.set(key, JSON.stringify({ version: 1, arrived: true, dismissed: true }));
    value.complete(); value = render(owner);
    assert.equal(value.seen, true); assert.equal(value.completionNotice, false);
    const old = value;
    render(other); value = render(other); old.complete(); old.dismissCompletion();
    value = render(other); assert.equal(value.seen, false); assert.equal(value.completionNotice, false);
    value.dismiss(); value = render(other, { ...opts, unlocked: false }); value.complete();
    value = render(other); assert.equal(value.seen, false, "a removed unlock rejects completion");
  }, useArrival));
}

test("miner actually keeps moving under the profile and finishes the same route after a busy pause", () => browser(({ render }) => {
  const owner = "miner-profile-physical-route", now = Date.parse("2026-11-01T12:00:00Z");
  const scene = { schemaVersion: 1, id: owner, width: 1254, height: 1254,
    focus: { x: 455, y: 480, width: 350, height: 350 }, actor: { spawn: { x: 630, y: 660 }, size: 36 },
    terrain: [], paths: [], ...compactVillagerFixture() };
  const state = createForestVillagers(scene), locked = { ...opts, confirmed: true, unlocked: false };
  render(owner, locked); render(owner, locked); render(owner, locked);
  let value = render(owner, { ...opts, confirmed: true }); value.dismiss();
  configureForestVillagers(state, scene, { confirmed: true, buildings: { quarry: 1, home: 1, woodlot: 0 }, allowArrival: value.enabled, now });
  assert.equal(state.arrivalPhase, "running");
  advanceForestVillagers(state, scene, .2, { now, arrivalActive: value.enabled });
  const beforeProfile = { ...state.residents.kamneshmyg.position };
  const profile = { ...opts, confirmed: true, enabled: false, continueEnabled: true };
  value = render(owner, profile);
  for (let i = 0; i < 5; i++) advanceForestVillagers(state, scene, .1, { now, arrivalActive: value.enabled });
  const afterProfile = { ...state.residents.kamneshmyg.position };
  assert.ok(Math.hypot(afterProfile.x - beforeProfile.x, afterProfile.y - beforeProfile.y) > 1, "profile leaves the physical arrival clock running");
  value = render(owner, { ...profile, continueEnabled: false });
  advanceForestVillagers(state, scene, .5, { now, arrivalActive: value.enabled });
  assert.deepEqual(state.residents.kamneshmyg.position, afterProfile, "busy economy still pauses at the current feet");
  value = render(owner, profile);
  for (let i = 0; i < 400 && !state.arrivalCompleted; i++) advanceForestVillagers(state, scene, .1, { now, arrivalActive: value.enabled });
  assert.equal(state.arrivalCompleted, true);
  value.complete(); value = render(owner, profile);
  assert.equal(value.seen, true); assert.equal(value.completionNotice, false);
  value = render(owner); assert.equal(value.completionNotice, true);
  value.complete(); value.dismissCompletion(); value = render(owner); assert.equal(value.completionNotice, false);
}, useMinerArrival));

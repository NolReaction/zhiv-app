import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const cacheDir = await mkdtemp(join(tmpdir(), "zhiv-section-manual-"));
const hooksId = "virtual:section-manual-hooks";
// Exercise SectionGuide's actual JSX handlers, storage and navigation effects.
// Only its hooks and visible browser geometry are adapted for the node runner.
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "section-manual-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let slots = [], cursor = 0, dirty = false, pending = new Map(), effects = new Set();
      function slot(create) { const index = cursor++; if (!(index in slots)) slots[index] = create(); return slots[index]; }
      export function reset() { for (const effect of effects) effect.cleanup?.(); slots = []; cursor = 0; dirty = false; pending.clear(); effects.clear(); }
      export function begin() { cursor = 0; dirty = false; }
      export function changed() { return dirty; }
      export function flush() { const work = [...pending]; pending.clear(); for (const [effect, callback] of work) { effect.cleanup?.(); const cleanup = callback(); effect.cleanup = typeof cleanup === 'function' ? cleanup : undefined; } }
      export function useRef(value) { return slot(() => ({ current: value })); }
      export function useState(initial) { const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial })); return [state.value, value => { const next = typeof value === 'function' ? value(state.value) : value; if (!Object.is(next, state.value)) { state.value = next; dirty = true; } }]; }
      export function useMemo(create, dependencies) { const memo = slot(() => ({ dependencies: undefined, value: undefined })); if (!memo.dependencies || dependencies.some((value, index) => !Object.is(value, memo.dependencies[index]))) { memo.dependencies = dependencies; memo.value = create(); } return memo.value; }
      export function useCallback(callback, dependencies) { return useMemo(() => callback, dependencies); }
      export function useEffect(callback, dependencies) { const effect = slot(() => ({ dependencies: undefined, cleanup: undefined })); effects.add(effect); if (!effect.dependencies || dependencies.some((value, index) => !Object.is(value, effect.dependencies[index]))) { effect.dependencies = dependencies; pending.set(effect, callback); } }
      export const useLayoutEffect = useEffect;
      export function useSyncExternalStore(subscribe, getSnapshot) { useEffect(() => subscribe(() => { dirty = true; }), [subscribe, getSnapshot]); return getSnapshot(); }
    `; },
    transform(source, id) {
      if (id.endsWith("/features/onboarding/section-guide.tsx") || id.endsWith("/features/onboarding/use-section-guide-preferences.ts"))
        return source.replace('from "react";', `from "${hooksId}";`);
    },
  }],
});
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const hooks = await vite.ssrLoadModule(hooksId);
const { SectionGuide } = await vite.ssrLoadModule("/features/onboarding/section-guide.tsx");
const { sectionGuideIds, sectionGuideLessons } = await vite.ssrLoadModule("/features/onboarding/section-guide-model.ts");
const { sectionGuideStorageKey } = await vite.ssrLoadModule("/features/onboarding/section-guide-storage.ts");
const { sectionGuideLauncherPreferenceKey } = await vite.ssrLoadModule("/features/onboarding/section-guide-preferences.ts");
const { listenForSectionGuideNavigation } = await vite.ssrLoadModule("/features/onboarding/section-guide-navigation.ts");
let identity = 0;
function elements(tree) {
  const nodes = [];
  function visit(node) { if (isValidElement(node)) { nodes.push(node); Children.forEach(node.props.children, visit); } }
  visit(tree); return nodes;
}
function text(tree) { return Children.toArray(tree).map(node => typeof node === "string" ? node : isValidElement(node) ? text(node.props.children) : "").join(""); }
function harness({ section = "pantry", status = null, step, preference = true, enabled = true } = {}) {
  hooks.reset();
  const names = ["window", "document", "HTMLElement", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame"];
  const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const values = new Map(), writes = [], frames = new Map(), focus = [], scrolls = [], navigation = [];
  const owner = `manual-owner-${++identity}`;
  const progressKey = sectionGuideStorageKey(owner, section), preferenceKey = sectionGuideLauncherPreferenceKey(owner);
  const progress = (state, stepId = sectionGuideLessons[section][1].id) => ({ version: 1, status: state, stepId });
  if (status) values.set(progressKey, JSON.stringify(progress(status, step)));
  values.set(preferenceKey, String(preference));
  class Element extends EventTarget {
    constructor(name) { super(); this.name = name; this.isConnected = true; this.parentElement = null; this.dataset = {}; }
    closest() { return null; }
    contains() { return true; }
    getClientRects() { return [{ x: 0, y: 0, width: 400, height: 300 }]; }
    focus() { focus.push(this.name); }
    scrollIntoView() { scrolls.push(this.name); }
  }
  const body = new Element("body"), scope = new Element("scope"), host = new Element("host"), target = new Element("target"), launcher = new Element("launcher"), content = new Element("plesk-content");
  scope.parentElement = body; host.parentElement = scope; content.parentElement = scope;
  scope.querySelector = selector => selector === '[data-section-guide-content="plesk"]' ? content : target;
  const stopNavigation = listenForSectionGuideNavigation(content, "plesk", stepId => { navigation.push(stepId); return true; });
  let frameId = 0;
  const browser = new EventTarget();
  browser.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); writes.push({ key, value }); } };
  browser.getComputedStyle = () => ({ visibility: "visible" });
  const globals = { window: browser, document: { body, querySelectorAll: () => [] }, HTMLElement: Element,
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame: id => frames.delete(id) };
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true });
  const props = { owner, section, enabled, targetRoot: { current: scope } };
  let tree;
  function render() {
    for (let round = 0; round < 30; round++) {
      hooks.begin(); tree = SectionGuide(props);
      tree.props.ref.current = host;
      for (const node of elements(tree)) if (node.type === "button" && node.props.ref) node.props.ref.current = launcher;
      hooks.flush();
      const work = [...frames]; frames.clear(); for (const [, callback] of work) callback();
      if (!hooks.changed() && frames.size === 0) return tree;
    }
    assert.fail("SectionGuide did not settle; effects must not write or schedule endlessly");
  }
  const coach = () => elements(render()).find(node => typeof node.type === "function" && node.type.name === "GuideCoach");
  const button = () => elements(render()).find(node => node.type === "button" && text(node.props.children) === "Что здесь делать?");
  function storageEvent(key = sectionGuideStorageKey(props.owner, props.section)) {
    const event = new Event("storage"); Object.defineProperty(event, "key", { value: key }); browser.dispatchEvent(event); render();
  }
  return { props, values, writes, focus, scrolls, navigation, progressKey, preferenceKey, render, coach, button,
    savedProgress() { const raw = values.get(sectionGuideStorageKey(props.owner, props.section)); return raw ? JSON.parse(raw) : null; },
    seed(nextStatus, stepId = sectionGuideLessons[props.section][1].id) {
      const key = sectionGuideStorageKey(props.owner, props.section);
      if (nextStatus === null) values.delete(key); else values.set(key, JSON.stringify({ version: 1, status: nextStatus, stepId }));
    },
    storageEvent,
    remount() { hooks.reset(); frames.clear(); return render(); },
    restore() { hooks.reset(); frames.clear(); stopNavigation(); for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } },
  };
}

test("every section waits for a launcher click on first entry, re-entry and restored progress", () => {
  for (const section of sectionGuideIds) for (const status of [null, "started", "paused", "completed", "skipped"]) {
    const session = harness({ section, status });
    try {
      const before = session.values.get(session.progressKey);
      assert.equal(session.coach(), undefined, `${section}/${status}: mount must stay quiet`);
      assert.ok(session.button());
      session.remount();
      assert.equal(session.coach(), undefined, `${section}/${status}: reload must stay quiet`);
      assert.equal(session.values.get(session.progressKey), before);
      assert.deepEqual(session.writes, [], "looking at a section never saves progress");
      assert.deepEqual(session.navigation, [], "visiting Plesk never opens an odds preview");
      assert.deepEqual(session.scrolls, []);
    } finally { session.restore(); }
  }
});

test("the real launcher starts, resumes or replays exactly the saved lesson state", () => {
  for (const status of [null, "started", "paused", "completed", "skipped"]) {
    const session = harness({ status });
    try {
      session.button().props.onClick();
      const coach = session.coach(), first = sectionGuideLessons.pantry[0].id, saved = sectionGuideLessons.pantry[1].id;
      assert.ok(coach); assert.equal(coach.props.stepId, `pantry:${status === "started" || status === "paused" ? saved : first}`);
      assert.equal(session.savedProgress().status, "started");
      assert.equal(session.writes.length, 1, "only the explicit launcher click saves progress");
      assert.equal(session.values.get(session.preferenceKey), "true");
    } finally { session.restore(); }
  }
});

test("pause, skip and completion end manual sessions while a later click resumes or replays", () => {
  const session = harness();
  try {
    session.button().props.onClick(); session.coach().props.primary.onClick();
    assert.equal(session.coach().props.stepId, "pantry:sale");
    session.coach().props.onPause();
    assert.equal(session.coach(), undefined); assert.equal(session.savedProgress().status, "paused");
    session.render(); assert.equal(session.coach(), undefined);
    session.button().props.onClick(); assert.equal(session.coach().props.stepId, "pantry:sale");
    session.coach().props.onBack(); assert.equal(session.coach().props.stepId, "pantry:items");
    session.coach().props.onSkip();
    assert.equal(session.coach(), undefined); assert.equal(session.savedProgress().status, "skipped");
    session.button().props.onClick(); assert.equal(session.coach().props.stepId, "pantry:items");
    for (let index = 0; index < sectionGuideLessons.pantry.length && session.coach(); index++) session.coach().props.primary.onClick();
    assert.equal(session.savedProgress().status, "completed"); assert.equal(session.coach(), undefined);
    session.render(); assert.equal(session.coach(), undefined);
    session.button().props.onClick(); assert.equal(session.coach().props.stepId, "pantry:items");
  } finally { session.restore(); }
});

test("a transient disabled parent yields the coach without discarding an explicitly requested session", () => {
  const session = harness({ status: "started", enabled: false });
  try {
    assert.equal(session.coach(), undefined); assert.equal(session.button(), undefined); assert.deepEqual(session.writes, []);
    session.props.enabled = true;
    assert.equal(session.coach(), undefined, "becoming eligible is not a request");
    session.button().props.onClick(); assert.equal(session.coach().props.stepId, "pantry:sale");
    const writes = session.writes.length;
    session.props.enabled = false; assert.equal(session.coach(), undefined);
    session.props.enabled = true; assert.equal(session.coach().props.stepId, "pantry:sale");
    assert.equal(session.writes.length, writes, "a modal guard cannot restart or consume the lesson");
    session.remount();
    assert.equal(session.coach(), undefined, "an actual re-entry never retains the previous explicit request");
    assert.equal(session.writes.length, writes);
  } finally { session.restore(); }
});

test("manual permission belongs to the exact owner and section store, including a return to the old scope", () => {
  const session = harness({ status: "started" });
  try {
    const originalOwner = session.props.owner;
    session.button().props.onClick(); assert.ok(session.coach());
    session.props.owner = `${originalOwner}-other`;
    session.seed("started");
    assert.equal(session.coach(), undefined, "another owner cannot inherit the request");
    session.button().props.onClick(); assert.ok(session.coach());
    session.props.section = "orders"; session.seed("paused");
    assert.equal(session.coach(), undefined, "another section requires its own request");
    session.button().props.onClick(); assert.equal(session.coach().props.stepId, "orders:reward");
    session.props.owner = originalOwner; session.props.section = "pantry";
    assert.equal(session.coach(), undefined, "returning creates a new store rather than reviving an old session");
    assert.equal(session.savedProgress().stepId, "sale");
  } finally { session.restore(); }
});

test("storage events update saved steps without auto-opening an inactive section", () => {
  const session = harness();
  try {
    for (const status of ["started", "paused", "completed", "skipped", null]) for (const key of [session.progressKey, null]) {
      session.seed(status); session.storageEvent(key);
      assert.equal(session.coach(), undefined); assert.ok(session.button());
      assert.deepEqual(session.writes, [], "external storage changes are read-only");
    }
  } finally { session.restore(); }
});

test("an external progress change ends manual permission even if another tab reports started again", () => {
  for (const status of ["started", "paused", "completed", "skipped", null]) {
    const session = harness();
    try {
      session.button().props.onClick(); assert.ok(session.coach());
      session.seed(status); session.storageEvent();
      assert.equal(session.coach(), undefined, status);
      session.seed("started", "market"); session.storageEvent(null);
      assert.equal(session.coach(), undefined, "external started cannot resurrect the closed session");
      const writes = session.writes.length;
      session.button().props.onClick(); assert.equal(session.coach().props.stepId, "pantry:market");
      assert.equal(session.writes.length, writes + 1);
    } finally { session.restore(); }
  }
});

test("unrelated storage and launcher preference changes do not close an active manual session", () => {
  const session = harness();
  try {
    session.button().props.onClick(); assert.ok(session.coach());
    const writes = session.writes.length;
    session.storageEvent("an-unrelated-setting"); assert.ok(session.coach());
    session.values.set(session.preferenceKey, "false"); session.storageEvent(session.preferenceKey); assert.ok(session.coach());
    assert.equal(session.writes.length, writes);
    session.coach().props.onSkip(); assert.equal(session.coach(), undefined); assert.equal(session.button(), undefined);
    assert.equal(session.values.get(session.preferenceKey), "false");
  } finally { session.restore(); }
});

test("Plesk odds reveal runs only after a real launcher click and remains scoped read-only navigation", () => {
  const session = harness({ section: "plesk", status: "started", step: "rods" });
  try {
    assert.equal(session.coach(), undefined); assert.deepEqual(session.navigation, []); assert.deepEqual(session.writes, []);
    session.storageEvent(); assert.deepEqual(session.navigation, []);
    session.button().props.onClick();
    assert.equal(session.coach().props.stepId, "plesk:rods"); assert.deepEqual(session.navigation, ["rods"]);
    const writes = session.writes.length;
    session.render(); session.render(); assert.deepEqual(session.navigation, ["rods"], "rerenders cannot repeat the automatic read-only reveal");
    session.coach().props.secondary.onClick(); assert.deepEqual(session.navigation, ["rods", "rods"]);
    assert.equal(session.writes.length, writes, "showing odds never changes lesson progress or game state");
  } finally { session.restore(); }
});

test("hidden launcher preferences remain intact and a saved pause still needs an explicit click", () => {
  for (const status of [null, "started", "paused", "completed", "skipped"]) {
    const session = harness({ status, preference: false });
    try {
      assert.equal(session.coach(), undefined);
      if (status === "paused") {
        assert.ok(session.button(), "the existing paused-resume launcher override is retained");
        session.button().props.onClick(); assert.equal(session.coach().props.stepId, "pantry:sale");
      } else { assert.equal(session.button(), undefined); assert.deepEqual(session.writes, []); }
      assert.equal(session.values.get(session.preferenceKey), "false");
      session.values.set(session.preferenceKey, "true"); session.storageEvent(session.preferenceKey);
      if (status !== "paused") { assert.equal(session.coach(), undefined); assert.ok(session.button()); }
    } finally { session.restore(); }
  }
});

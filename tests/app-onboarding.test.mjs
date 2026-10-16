import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:app-onboarding-hooks";
const vite = await createServer({
  appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{
    name: "app-onboarding-hooks", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let guide, dialogOpen = false;
      export function setGuide(value) { guide = value; }
      export function setDialogOpen(value) { dialogOpen = value; }
      export function useAppOnboarding() { return guide; }
      export function useAppDialogOpen() { return dialogOpen; }
      export function useAppGuideTarget() {}
      export function useImperativeHandle(ref, create) { if (ref) ref.current = create(); }
    `; },
    transform(source, id) {
      if (id.endsWith("/features/app/onboarding/app-onboarding.tsx")) return source
        .replace('from "./use-app-onboarding";', `from "${hookModule}";`)
        .replace('from "./use-app-dialog-open";', `from "${hookModule}";`)
        .replace('from "./use-app-guide-target";', `from "${hookModule}";`)
        .replace('import { useImperativeHandle, type Ref } from "react";', `import { useImperativeHandle } from "${hookModule}";`);
    },
  }],
});
after(() => vite.close());
const { APP_ONBOARDING_STEPS, parseAppOnboarding, startAppOnboarding, observeAppOnboarding,
  advanceAppOnboarding, previousAppOnboarding } = await vite.ssrLoadModule("/features/app/onboarding/app-onboarding-model.ts");
const { createAppOnboardingStore, appOnboardingStorageKey } = await vite.ssrLoadModule("/features/app/onboarding/app-onboarding-storage.ts");
const { AppOnboarding } = await vite.ssrLoadModule("/features/app/onboarding/app-onboarding.tsx");
const { GuideCoach } = await vite.ssrLoadModule("/features/onboarding/guide-coach.tsx");
const hooks = await vite.ssrLoadModule(hookModule);
const now = Date.parse("2026-10-08T10:00:00Z");
const oldCheckIn = "2026-10-07T10:00:00Z";
const newCheckIn = "2026-10-08T10:00:00Z";
const evidence = (overrides = {}) => ({ activeView: "check-in", lastCheckInAt: oldCheckIn,
  nextAllowedAt: null, nowMs: now, unconfirmed: false, isSending: false, calendarOpen: false, worldOpen: false, ...overrides });
const started = (stepId = "check-in") => ({ ...startAppOnboarding(oldCheckIn), stepId });

test("new app guide is independent of the world guide and round-trips every stable step", () => {
  assert.deepEqual(APP_ONBOARDING_STEPS, ["check-in", "calendar", "people", "profile", "world"]);
  for (const step of APP_ONBOARDING_STEPS) assert.deepEqual(parseAppOnboarding(JSON.stringify(started(step))), started(step));
  assert.equal(appOnboardingStorageKey("PLAYER"), "zhiv.app-onboarding.v2:PLAYER");
});

test("malformed, stale and unknown progress cannot skip the application introduction", () => {
  for (const raw of [null, "{", "null", "[]", "false", JSON.stringify({ version: 1, status: "completed" }),
    JSON.stringify({ ...started(), stepId: "unknown" }), JSON.stringify({ ...started(), completedSteps: ["future"] }),
    JSON.stringify({ ...started(), baselineCheckInAt: "invalid" })]) assert.equal(parseAppOnboarding(raw), null);
});

test("skipped and completed decisions remain distinct and do not retain an old step", () => {
  for (const status of ["skipped", "completed"]) assert.deepEqual(parseAppOnboarding(JSON.stringify({ version: 2, status, stepId: "people" })), { version: 2, status });
});

test("an old check-in, a local pending click, or an unconfirmed response cannot satisfy the exercise", () => {
  const progress = started();
  assert.equal(observeAppOnboarding(progress, evidence()), progress);
  for (const override of [{ isSending: true }, { unconfirmed: true }]) {
    assert.equal(observeAppOnboarding(progress, evidence({ lastCheckInAt: newCheckIn, ...override })), progress);
  }
  assert.equal(observeAppOnboarding(progress, evidence({ lastCheckInAt: "invalid" })), progress);
});

test("confirmed check-in succeeds but leaves the result visible until the player continues", () => {
  const result = observeAppOnboarding(started(), evidence({ lastCheckInAt: newCheckIn }));
  assert.equal(result.stepId, "check-in");
  assert.deepEqual(result.completedSteps, ["check-in"]);
  assert.equal(observeAppOnboarding(result, evidence({ lastCheckInAt: newCheckIn })), result);
});

test("an already confirmed check-in in cooldown is enough; no repeated mark is required", () => {
  const result = observeAppOnboarding(started(), evidence({ nextAllowedAt: "2026-10-08T11:00:00Z" }));
  assert.deepEqual(result.completedSteps, ["check-in"]);
  assert.deepEqual(observeAppOnboarding(started(), evidence({ nextAllowedAt: "2026-10-08T09:59:59Z" })).completedSteps, []);
});

test("calendar opening is remembered across closure and reload", () => {
  let result = observeAppOnboarding(started("calendar"), evidence({ calendarOpen: true }));
  result = parseAppOnboarding(JSON.stringify(result));
  assert.deepEqual(observeAppOnboarding(result, evidence()).completedSteps, ["calendar"]);
  assert.equal(result.stepId, "calendar");
});

test("visiting the requested app section satisfies only the active exercise", () => {
  for (const step of ["people", "profile"]) {
    assert.deepEqual(observeAppOnboarding(started(step), evidence()).completedSteps, []);
    assert.deepEqual(observeAppOnboarding(started(step), evidence({ activeView: step })).completedSteps, [step]);
  }
  assert.deepEqual(observeAppOnboarding(started("calendar"), evidence({ activeView: "profile" })).completedSteps, []);
});

test("skipping unavailable tasks does not pretend they were done and never traps the user", () => {
  let state = started();
  for (const step of APP_ONBOARDING_STEPS) {
    assert.equal(state.stepId, step);
    assert.deepEqual(state.completedSteps, []);
    state = advanceAppOnboarding(state);
  }
  assert.deepEqual(state, { version: 2, status: "completed" });
});

test("opening the world only finishes the application guide at its world step", () => {
  assert.deepEqual(observeAppOnboarding(started("world"), evidence({ worldOpen: true })), { version: 2, status: "completed" });
  assert.equal(observeAppOnboarding(started("calendar"), evidence({ worldOpen: true })).stepId, "calendar");
});

test("back returns to the previous stable step without erasing accomplished tasks", () => {
  const state = { ...started("profile"), completedSteps: ["check-in", "calendar", "people"] };
  assert.deepEqual(previousAppOnboarding(state), { ...state, stepId: "people" });
  const first = started();
  assert.equal(previousAppOnboarding(first), first);
});

test("per-account store preserves resume, skip and restart without changing the server snapshot", () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const first = createAppOnboardingStore("FIRST", storage);
  first.restore(); first.save(started("people"));
  const second = createAppOnboardingStore("SECOND", storage);
  second.restore(); second.save({ version: 2, status: "skipped" });
  const restored = createAppOnboardingStore("FIRST", storage);
  restored.restore();
  assert.deepEqual(restored.getSnapshot().progress, started("people"));
  assert.deepEqual(second.getSnapshot().progress, { version: 2, status: "skipped" });
  assert.deepEqual(restored.getServerSnapshot(), { loaded: false, progress: null, paused: false });
  restored.save(null);
  assert.equal(parseAppOnboarding(values.get(appOnboardingStorageKey("FIRST"))), null);
});

test("failed local storage remains usable in memory and stable snapshots avoid render loops", () => {
  const denied = { getItem() { throw Error("denied"); }, setItem() { throw Error("denied"); } };
  const store = createAppOnboardingStore("DENIED", denied);
  let changes = 0;
  const unsubscribe = store.subscribe(() => changes++);
  store.restore(); store.save(started("calendar"));
  const snapshot = store.getSnapshot();
  store.save(started("calendar"));
  assert.equal(store.getSnapshot(), snapshot);
  assert.equal(changes, 2);
  unsubscribe(); store.save({ version: 2, status: "skipped" });
  assert.equal(changes, 2);
  const reopened = createAppOnboardingStore("DENIED", denied);
  reopened.restore();
  assert.deepEqual(reopened.getSnapshot().progress, { version: 2, status: "skipped" });
});

test("closing the app welcome or a lesson persists across reload until explicit resume", () => {
  for (const progress of [null, { ...started("profile"), completedSteps: ["check-in", "calendar"] }]) {
    const values = new Map();
    const disk = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    const owner = `app-pause-${progress?.stepId ?? "welcome"}`;
    const first = createAppOnboardingStore(owner, disk);
    first.restore(); first.save(progress); first.setPaused(true);
    const reopened = createAppOnboardingStore(owner, disk);
    reopened.restore();
    assert.deepEqual(reopened.getSnapshot(), { loaded: true, progress, paused: true });
    const other = createAppOnboardingStore(`${owner}-other`, disk);
    other.restore();
    assert.equal(other.getSnapshot().paused, false, "one account cannot silence another account's tutorial");
    reopened.setPaused(false);
    const resumed = createAppOnboardingStore(owner, disk);
    resumed.restore();
    assert.deepEqual(resumed.getSnapshot(), { loaded: true, progress, paused: false });
  }
});

test("app pause survives blocked storage, and restored writes allow cross-tab pause updates", () => {
  const values = new Map();
  let writable = false;
  const disk = { getItem: key => values.get(key) ?? null, setItem(key, value) {
    if (!writable) throw Error("denied");
    values.set(key, value);
  } };
  const first = createAppOnboardingStore("app-pause-recovery", disk);
  first.restore(); first.save(started("people")); first.setPaused(true);
  const reopened = createAppOnboardingStore("app-pause-recovery", disk);
  reopened.restore();
  assert.equal(reopened.getSnapshot().paused, true);
  assert.equal(reopened.getSnapshot().progress.stepId, "people");
  writable = true;
  reopened.setPaused(false);
  disk.setItem(reopened.pauseStorageKey, "true");
  reopened.restore();
  assert.equal(reopened.getSnapshot().paused, true);
  disk.setItem(reopened.pauseStorageKey, "false");
  reopened.restore();
  assert.equal(reopened.getSnapshot().paused, false);
});

function view(stepId, overrides = {}, completed = []) {
  const calls = [];
  const record = name => () => calls.push(name);
  hooks.setDialogOpen(false);
  hooks.setGuide({ progress: stepId ? { ...started(stepId), completedSteps: completed } : null, open: true, paused: false,
    ...Object.fromEntries(["start", "next", "back", "skip", "pause", "resume", "replay"].map(name => [name, record(name)])) });
  const tree = AppOnboarding({ ...evidence(), owner: "UI-PLAYER", ready: true, suspended: false,
    isOnline: true, calendarAvailable: true, simpleView: false, ...overrides });
  return { calls, props: Children.toArray(tree.props.children).find(child => isValidElement(child) && child.type === GuideCoach).props };
}

test("welcome starts only the course and never navigates or sends a check-in", () => {
  const result = view();
  assert.equal(result.props.stepId, "welcome");
  assert.match(result.props.text, /близкие/);
  assert.ok(result.props.text.length < 90);
  assert.equal(result.props.hint, undefined);
  assert.equal(result.props.inline, true);
  result.props.primary.onClick();
  assert.deepEqual(result.calls, ["start"]);
});

test("check-in asks for the real button; offline and unavailable states still offer skip", () => {
  for (const override of [{}, { isOnline: false }, { unconfirmed: true }, { isSending: true }]) {
    const result = view("check-in", override);
    assert.equal(result.props.target, '[data-app-onboarding="check-in"]');
    assert.equal(result.props.primary, undefined);
    result.props.secondary.onClick();
    assert.deepEqual(result.calls, ["next"]);
  }
});

test("calendar and world lessons wait for the real highlighted controls", () => {
  for (const step of ["calendar", "world"]) {
    const lesson = view(step);
    assert.equal(lesson.props.primary, undefined);
    assert.equal(lesson.props.target, `[data-app-onboarding="${step}"]`);
    assert.deepEqual(lesson.calls, []);
  }
});

test("wrong-screen lessons highlight real navigation without switching tabs for the user", () => {
  for (const step of ["check-in", "calendar", "world"]) {
    const lesson = view(step, { activeView: "people" });
    assert.equal(lesson.props.primary, undefined);
    assert.equal(lesson.props.target, '[data-app-onboarding="nav-check-in"]');
    assert.match(lesson.props.summary, /«Я живой» внизу/);
    assert.deepEqual(lesson.calls, []);
  }
  for (const step of ["people", "profile"]) {
    const lesson = view(step);
    assert.equal(lesson.props.primary, undefined);
    assert.equal(lesson.props.target, `[data-app-onboarding="nav-${step}"]`);
    assert.deepEqual(lesson.calls, []);
  }
  for (const override of [{ ready: false }, { suspended: true }, { calendarOpen: true }, { worldOpen: true }]) {
    assert.equal(view("calendar", override).props.open, false);
  }
});

test("different tasks and confirmed success have different Mochlik poses", () => {
  const poses = new Set(APP_ONBOARDING_STEPS.map(step => view(step).props.pose));
  assert.ok(poses.size >= 4);
  assert.notEqual(view("check-in").props.pose, view("check-in", {}, ["check-in"]).props.pose);
});

test("simple view is respected while the existing independent map button remains available", () => {
  const result = view("world", { simpleView: true });
  assert.match(result.props.hint, /простая кнопка/);
  assert.equal(result.props.primary, undefined);
  assert.equal(result.props.target, '[data-app-onboarding="world"]');
  assert.deepEqual(result.calls, []);
});

test("opened app sections highlight their own content and every task has a concise actionable summary", () => {
  for (const step of ["people", "profile"]) {
    assert.equal(view(step).props.target, `[data-app-onboarding="nav-${step}"]`);
    const result = view(step, { activeView: step }, [step]);
    assert.equal(result.props.target, `[data-app-onboarding="${step === "profile" ? "profile-settings" : "people-content"}"]`);
    assert.ok(result.props.summary.length > 0 && result.props.summary.length < 160);
    assert.deepEqual(result.calls, []);
  }
  for (const step of APP_ONBOARDING_STEPS) {
    assert.ok(view(step).props.summary.length > 0 && view(step).props.summary.length < 160);
  }
});


test("profile question entry resumes the saved app step and replays only a finished course", () => {
  const entryRef = { current: null };
  const progress = view("people", { entryRef });
  assert.equal(entryRef.current.getActionLabel(), "Продолжить обучение");
  assert.deepEqual(progress.calls, []);
  entryRef.current.open();
  assert.deepEqual(progress.calls, ["resume"]);
  const fresh = view(null, { entryRef });
  assert.equal(entryRef.current.getActionLabel(), "Начать обучение");
  assert.deepEqual(fresh.calls, []);
  entryRef.current.open();
  assert.deepEqual(fresh.calls, ["replay"]);
});

test("only completed-step advancement can run from the small speech and character", () => {
  for (const step of ["check-in", "calendar", "people", "profile"]) {
    const currentView = ["people", "profile"].includes(step) ? step : "check-in";
    assert.equal(view(step, { activeView: currentView }, [step]).props.primary.advance, true);
    assert.notEqual(view(step).props.primary?.advance, true);
  }
  assert.equal(view("world").props.primary, undefined);
  assert.notEqual(view(null).props.primary.advance, true);
});


test("finished app courses expose a replay label without resetting until the explicit action", () => {
  for (const status of ["completed", "skipped"]) {
    const calls = [];
    const entryRef = { current: null };
    const progress = { version: 2, status };
    hooks.setGuide({ progress, open: false, replay: () => calls.push("replay"), resume: () => calls.push("resume") });
    hooks.setDialogOpen(false);
    AppOnboarding({ ...evidence(), owner: "UI-PLAYER", ready: true, suspended: false,
      isOnline: true, calendarAvailable: true, simpleView: false, entryRef });
    assert.equal(entryRef.current.getActionLabel(), "Повторить обучение");
    assert.deepEqual(calls, []);
    entryRef.current.open();
    assert.deepEqual(calls, ["replay"]);
  }
});

test("the profile lesson points at settings and introduces the gear without requiring personal data", () => {
  const lesson = view("profile", { activeView: "profile" }, ["profile"]);
  assert.equal(lesson.props.target, '[data-app-onboarding="profile-settings"]');
  assert.match(lesson.props.summary, /Нажми шестерёнку/);
  assert.doesNotMatch(lesson.props.summary, /Нажми «Личные данные»/);
  assert.deepEqual(lesson.calls, [], "the real tab remains a user action");
});

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
    `; },
    transform(source, id) {
      if (id.endsWith("/features/app/onboarding/app-onboarding.tsx")) return source
        .replace('from "./use-app-onboarding";', `from "${hookModule}";`)
        .replace('from "./use-app-dialog-open";', `from "${hookModule}";`);
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
  assert.deepEqual(restored.getServerSnapshot(), { loaded: false, progress: null });
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

function view(stepId, overrides = {}, completed = []) {
  const calls = [];
  const record = name => () => calls.push(name);
  hooks.setDialogOpen(false);
  hooks.setGuide({ progress: stepId ? { ...started(stepId), completedSteps: completed } : null, open: true, paused: false,
    ...Object.fromEntries(["start", "next", "back", "skip", "pause", "resume", "replay"].map(name => [name, record(name)])) });
  const tree = AppOnboarding({ ...evidence(), owner: "UI-PLAYER", ready: true, suspended: false,
    isOnline: true, calendarAvailable: true, simpleView: false,
    onSelect: next => calls.push(`select:${next}`), onOpenCalendar: record("open-calendar"), onEnterWorld: record("enter-world"), ...overrides });
  return { calls, props: Children.toArray(tree.props.children).find(child => isValidElement(child) && child.type === GuideCoach).props };
}

test("welcome is opt-in and starting uses application navigation without sending a check-in", () => {
  const result = view();
  assert.equal(result.props.stepId, "welcome");
  assert.match(result.props.text, /близкие/);
  result.props.primary.onClick();
  assert.deepEqual(result.calls, ["select:check-in", "start"]);
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

test("calendar and world buttons use the existing app open handlers", () => {
  const calendar = view("calendar"); calendar.props.primary.onClick();
  assert.deepEqual(calendar.calls, ["open-calendar"]);
  const world = view("world"); world.props.primary.onClick();
  assert.deepEqual(world.calls, ["enter-world"]);
});

test("unrelated navigation can return home, and the guide stays out of real app dialogs", () => {
  const otherView = view("calendar", { activeView: "people" }); otherView.props.primary.onClick();
  assert.deepEqual(otherView.calls, ["select:check-in"]);
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
  result.props.primary.onClick();
  assert.deepEqual(result.calls, ["enter-world"]);
});

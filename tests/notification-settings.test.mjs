import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:notification-settings-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "notification-settings-state", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots = [], cursor = 0, effects = [], snapshot;
      export const saves = [];
      export function reset(value) { for (const slot of slots) slot?.cleanup?.(); slots = []; cursor = 0; effects = []; snapshot = value; saves.length = 0; }
      export function begin() { cursor = 0; effects = []; }
      export function useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }]; }
      export function useRef(value) { return useState(() => ({ current: value }))[0]; }
      export function useId() { return 'notification-test'; }
      export function useCallback(callback, deps) { const i = cursor++, previous = slots[i]; if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) slots[i] = { callback, deps }; return slots[i].callback; }
      export function useEffect(callback, deps) { const i = cursor++, previous = slots[i]?.deps; if (!previous || deps.some((value, index) => !Object.is(value, previous[index]))) effects.push({ i, callback, deps }); }
      export function useImperativeHandle(ref, create, deps) { useEffect(() => { if (ref) ref.current = create(); return () => { if (ref) ref.current = null; }; }, [...deps, ref]); }
      export function commit() { const pending = effects; effects = []; for (const { i, callback, deps } of pending) { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: callback() }; } }
      export function useNotificationDevice(owner, online, apply) { useEffect(() => { apply(snapshot); }, [snapshot, apply]); return { busy: false, state: {}, pauseRefresh() {}, resumeRefresh() {}, refresh() {}, toggle() {} }; }
      export function saveNotificationPreferences(owner, preferences) { return new Promise((resolve, reject) => saves.push({ owner, preferences, resolve, reject })); }
    `; },
    transform(source, id) { if (id.endsWith("/features/notifications/notification-settings.tsx")) return source
      .replace('from "react";', `from "${hookModule}";`)
      .replace('from "./use-notification-device";', `from "${hookModule}";`)
      .replace('from "./notification-api";', `from "${hookModule}";`); },
  }],
});
after(() => vite.close());
const { NotificationSettingsPanel } = await vite.ssrLoadModule("/features/notifications/notification-settings.tsx");
const { defaultNotificationPreferences } = await vite.ssrLoadModule("/features/notifications/notification-contract.ts");
const hooks = await vite.ssrLoadModule(hookModule);
const originalGlobals = Object.fromEntries(["window", "document", "HTMLElement"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
afterEach(() => {
  hooks.reset();
  for (const [key, descriptor] of Object.entries(originalGlobals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
});
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
function elements(tree) { const result = []; function walk(node) { if (!isValidElement(node)) return; result.push(node); Children.forEach(node.props.children, walk); } walk(tree); return result; }
function setup() {
  const initial = { ownerPublicId: "AAAA-0000-0001", preferences: defaultNotificationPreferences("Europe/Moscow"), delivery: { configured: true, publicKey: "public", reason: null }, subscription: { subscribed: false } };
  hooks.reset(initial);
  const listeners = new Map();
  globalThis.window = { addEventListener: (type, callback) => listeners.set(type, callback), removeEventListener: (type, callback) => { if (listeners.get(type) === callback) listeners.delete(type); } };
  globalThis.HTMLElement = class { isConnected = true; focused = 0; attributes = {}; focus() { this.focused++; } getAttribute(name) { return this.attributes[name] ?? null; } };
  const trigger = new globalThis.HTMLElement();
  const heading = new globalThis.HTMLElement();
  globalThis.document = { activeElement: trigger };
  const exitRef = { current: null }, props = { ownerPublicId: initial.ownerPublicId, isOnline: true, onSessionLost() {}, exitRef };
  function render() {
    hooks.begin(); const wrapper = NotificationSettingsPanel(props), tree = wrapper.type(wrapper.props); hooks.commit();
    const nodes = elements(tree);
    nodes.find(node => node.type === "h2").props.ref.current = heading;
    return { nodes, dialog: nodes.find(node => node.type.name === "Dialog"), content: nodes.find(node => node.type.name === "DialogContent"),
      button: text => nodes.find(node => node.type === "button" && node.props.children === text),
      toggle: key => nodes.find(node => node.props.id === `notification-test-${key}`),
      save: nodes.find(node => node.type === "button" && Array.isArray(node.props.children) && node.props.children.some(child => child === "Сохранить настройки" || child === "Сохраняем…")) };
  }
  render(); render();
  return { initial, props, exitRef, listeners, trigger, heading, render, edit() { render().toggle("checkinReminder").props.onCheckedChange(true); return render(); } };
}

test("clean or reverted preferences leave immediately without warning", () => {
  const app = setup(); let left = 0;
  app.exitRef.current.requestLeave(() => left++);
  assert.equal(left, 1); assert.equal(app.render().dialog.props.open, false); assert.equal(app.listeners.size, 0);
  app.edit(); app.render().toggle("checkinReminder").props.onCheckedChange(false); app.render();
  app.exitRef.current.requestLeave(() => left++);
  assert.equal(left, 2); assert.equal(app.render().dialog.props.open, false); assert.equal(app.listeners.size, 0);
});

test("administration category is independently editable and saved without connecting the device", async () => {
  const app = setup();
  assert.equal(app.render().toggle("administrationMessages").props.checked, true);
  app.render().toggle("administrationMessages").props.onCheckedChange(false);
  app.render().save.props.onClick();
  await tick();
  assert.equal(hooks.saves.length, 1);
  assert.equal(hooks.saves[0].preferences.administrationMessages, false);
  assert.equal(hooks.saves[0].preferences.productionCompleted, true);
  hooks.saves[0].resolve({ ...app.initial, preferences: hooks.saves[0].preferences });
  await tick();
  assert.equal(app.render().toggle("administrationMessages").props.checked, false);
});

test("cancel button and dialog dismissal preserve draft and return focus without leaving", () => {
  const app = setup(); app.edit(); let left = 0;
  for (const dismiss of [view => view.button("Вернуться к настройкам").props.onClick(), view => view.dialog.props.onOpenChange(false)]) {
    app.exitRef.current.requestLeave(() => left++);
    const view = app.render(); assert.equal(view.dialog.props.open, true);
    dismiss(view);
    const cancelled = app.render(); assert.equal(cancelled.dialog.props.open, false); assert.equal(cancelled.toggle("checkinReminder").props.checked, true);
    let prevented = false; cancelled.content.props.onCloseAutoFocus({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
  assert.equal(left, 0); assert.equal(app.trigger.focused, 2);
  const unload = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };
  app.listeners.get("beforeunload")(unload); assert.equal(unload.prevented, true); assert.equal(unload.returnValue, "");
});

test("explicit discard restores saved preferences and executes the requested navigation once", () => {
  const app = setup(); app.edit(); let left = 0;
  app.exitRef.current.requestLeave(() => left++);
  app.exitRef.current.requestLeave(() => { left += 100; });
  app.render().button("Выйти без сохранения").props.onClick();
  const view = app.render();
  assert.equal(left, 1); assert.equal(view.dialog.props.open, false); assert.equal(view.toggle("checkinReminder").props.checked, false); assert.equal(view.save.props.disabled, true); assert.equal(app.listeners.size, 0);
  view.content.props.onCloseAutoFocus({ preventDefault() {} }); assert.equal(app.trigger.focused, 0, "the completed destination owns focus");
});

test("cancel focus returns to the form if the exit trigger is an inactive tab or was removed", () => {
  const app = setup(); app.edit();
  for (const prepare of [() => { app.trigger.attributes = { role: "tab", "aria-selected": "false" }; }, () => { app.trigger.attributes = {}; app.trigger.isConnected = false; }]) {
    prepare(); app.exitRef.current.requestLeave(() => assert.fail("cancel cannot navigate"));
    app.render().dialog.props.onOpenChange(false);
    app.render().content.props.onCloseAutoFocus({ preventDefault() {} });
  }
  assert.equal(app.trigger.focused, 0); assert.equal(app.heading.focused, 2);
});

test("successful save clears dirty state; rejected save keeps the draft and warning", async () => {
  const app = setup(); app.edit(); app.render().save.props.onClick(); app.render();
  assert.equal(hooks.saves.length, 1);
  hooks.saves[0].reject(new Error("Сеть недоступна")); await tick(); app.render();
  let left = 0; app.exitRef.current.requestLeave(() => left++);
  let view = app.render(); assert.equal(view.dialog.props.open, true); assert.equal(left, 0); assert.equal(view.toggle("checkinReminder").props.checked, true);
  assert.ok(view.nodes.some(node => node.props.role === "status" && node.props.children === "Сеть недоступна"));
  view.button("Вернуться к настройкам").props.onClick(); app.render().save.props.onClick(); app.render();
  hooks.saves[1].resolve({ ...app.initial, preferences: hooks.saves[1].preferences }); await tick(); app.render();
  app.exitRef.current.requestLeave(() => left++); view = app.render();
  assert.equal(left, 1); assert.equal(view.dialog.props.open, false); assert.equal(view.save.props.disabled, true); assert.equal(app.listeners.size, 0);
});

test("leaving during save waits for confirmation and cannot discard an in-flight mutation", async () => {
  const app = setup(); app.edit(); app.render().save.props.onClick(); app.render(); let left = 0;
  app.exitRef.current.requestLeave(() => left++);
  const waiting = app.render(); assert.equal(waiting.dialog.props.open, true); assert.equal(waiting.button("Выйти без сохранения").props.disabled, true);
  waiting.button("Выйти без сохранения").props.onClick(); assert.equal(left, 0);
  hooks.saves[0].resolve({ ...app.initial, preferences: hooks.saves[0].preferences }); await tick();
  const view = app.render(); assert.equal(left, 1); assert.equal(view.dialog.props.open, false); assert.equal(app.listeners.size, 0);
});

test("a save error while exit is pending keeps the warning and draft for explicit cancel or discard", async () => {
  const app = setup(); app.edit(); app.render().save.props.onClick(); app.render(); let left = 0;
  app.exitRef.current.requestLeave(() => left++); app.render();
  hooks.saves[0].reject(new Error("Не удалось сохранить")); await tick();
  const view = app.render(); assert.equal(left, 0); assert.equal(view.dialog.props.open, true); assert.equal(view.toggle("checkinReminder").props.checked, true);
  assert.equal(view.button("Выйти без сохранения").props.disabled, false);
  assert.ok(view.nodes.some(node => node.props.role === "status" && node.props.children === "Не удалось сохранить"));
  view.button("Вернуться к настройкам").props.onClick(); assert.equal(app.render().dialog.props.open, false); assert.equal(left, 0);
});

test("cancelling a pending exit or unmounting prevents late save completion from navigating", async () => {
  const app = setup(); app.edit(); app.render().save.props.onClick(); app.render(); let left = 0;
  app.exitRef.current.requestLeave(() => left++); app.render().dialog.props.onOpenChange(false); app.render();
  hooks.saves[0].resolve({ ...app.initial, preferences: hooks.saves[0].preferences }); await tick(); app.render(); assert.equal(left, 0);
  app.render().toggle("checkinReminder").props.onCheckedChange(false); app.render().save.props.onClick(); app.render();
  app.exitRef.current.requestLeave(() => left++); app.render();
  const saving = hooks.saves[1]; hooks.reset();
  assert.equal(app.exitRef.current, null); assert.equal(app.listeners.size, 0);
  saving.resolve({ ...app.initial, preferences: saving.preferences }); await tick(); assert.equal(left, 0);
});

test("offline changes still warn and validation errors never silently clear the draft", () => {
  const app = setup(); app.props.isOnline = false; app.edit(); let left = 0;
  assert.equal(app.render().save.props.disabled, true);
  app.exitRef.current.requestLeave(() => left++); assert.equal(app.render().dialog.props.open, true); assert.equal(left, 0);
  app.render().dialog.props.onOpenChange(false); app.props.isOnline = true;
  app.render().nodes.find(node => node.props.id === "notification-test-until").props.onChange({ target: { value: "23:00" } });
  app.render().save.props.onClick(); app.render(); assert.equal(hooks.saves.length, 0);
  app.exitRef.current.requestLeave(() => left++); assert.equal(app.render().dialog.props.open, true); assert.equal(left, 0);
});

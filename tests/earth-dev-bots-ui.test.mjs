import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), hooksId = "virtual:earth-dev-bots-ui-hooks";
const cacheDir = await mkdtemp(join(tmpdir(), "zhiv-earth-dev-bots-ui-"));
// Exercise real action handlers and React elements. The hook adapter models
// state/effect lifetimes; it does not claim to exercise native browser events.
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "earth-dev-bots-ui-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let current, cursor, controller, requests = [];
      function slot(create) { const index = cursor++; if (!(index in current.slots)) current.slots[index] = create(); return current.slots[index]; }
      export function begin(state) { current = state; cursor = 0; state.dirty = false; }
      export function flush(state) { const pending = state.pending.splice(0); for (const effect of pending) effect(); }
      export function dispose(state) { for (const slot of state.slots) slot.cleanup?.(); }
      export function useState(initial) {
        const owner = current, state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
        return [state.value, value => { const next = typeof value === 'function' ? value(state.value) : value;
          if (!Object.is(next, state.value)) { state.value = next; owner.dirty = true; } }];
      }
      export function useRef(value) { return slot(() => ({ current: value })); }
      export function useEffect(effect, deps) {
        const owner = current, state = slot(() => ({ deps: undefined, cleanup: undefined }));
        if (!deps || !state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) {
          state.deps = deps; owner.pending.push(() => { state.cleanup?.(); state.cleanup = effect(); });
        }
      }
      export function setController(value) { controller = value; requests = []; }
      export function useDevBots(owner, enabled) { requests.push({ owner, enabled }); return controller; }
      export function hookRequests() { return requests; }
    `; },
    transform(source, id) {
      if (id.endsWith("/features/earth/dev/earth-dev-bots.tsx")) return source
        .replace('from "react";', `from "${hooksId}";`)
        .replace('from "@/features/world/dev/use-dev-bots";', `from "${hooksId}";`);
    },
  }],
});
const hooks = await vite.ssrLoadModule(hooksId);
const { EarthDevBotControls, EarthDevBotsContent, EarthDevBots } = await vite.ssrLoadModule("/features/earth/dev/earth-dev-bots.tsx");
const states = [];
afterEach(() => { for (const state of states.splice(0)) hooks.dispose(state); });
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const NOW = Date.parse("2026-10-20T12:00:00Z");
const iso = offset => new Date(NOW + offset).toISOString();
const point = { latitude: 55.75, longitude: 37.62, accuracyMeters: 20 };

function bot(id = "01234567-1234-4123-8123-123456789012") {
  return { id, publicId: `BOT-${id}`, displayName: "Тестовый сосед", circleId: `circle-${id}`, sharingMode: "LATEST_ONLY",
    createdAt: iso(-60_000), lastCheckInAt: null,
    earth: { mode: "OFF", precision: "APPROXIMATE", sharingUntil: null, position: { ...point },
      sharedUpdatedAt: null, sharedExpiresAt: null, nextPublishAt: null } };
}
function nodes(tree) {
  const all = [], visit = node => { if (isValidElement(node)) { all.push(node); Children.forEach(node.props.children, visit); } };
  visit(tree); return all;
}
const text = node => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : isValidElement(node) ? text(node.props.children) : "";
function harness(Component, props) {
  const state = { slots: [], pending: [], dirty: false }, focus = [];
  states.push(state);
  return { focus, render() {
    for (let pass = 0; pass < 10; pass++) {
      hooks.begin(state); const tree = Component(props), all = nodes(tree);
      for (const node of all) if (node.props.ref && typeof node.props.ref === "object") node.props.ref.current = {
        focus(options) { focus.push({ tag: node.type, label: node.props["aria-label"] ?? text(node), options }); },
      };
      hooks.flush(state);
      if (!state.dirty) return { tree, nodes: all };
    }
    throw Error("Hook harness did not settle");
  } };
}
const button = (view, label) => view.nodes.find(node => node.type === "button" && (text(node) === label || node.props["aria-label"] === label));
function input(view, label) {
  const node = view.nodes.find(node => node.type === "label" && text(node).startsWith(label));
  assert.ok(node, `Label ${label} exists`);
  return Children.toArray(node.props.children).find(child => isValidElement(child) && ["input", "select"].includes(child.type));
}
function submit(view, label) {
  const control = button(view, label), form = view.nodes.find(node => node.type === "form" && nodes(node).includes(control));
  assert.ok(form, `Form for ${label} exists`);
  let prevented = false; form.props.onSubmit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true, "submitting a local command never navigates");
}
function controls(extra = {}) {
  const calls = [], focused = [], selected = bot();
  const props = { bot: selected, disabled: false, now: NOW, position: null,
    readCenter: () => ({ latitude: 40.7, longitude: -74 }), command: async action => { calls.push(action); },
    onFocus: circleId => focused.push(circleId), ...extra };
  return { calls, focused, bot: selected, props, h: harness(EarthDevBotControls, props) };
}
function content() {
  const selected = bot(), calls = [], changed = [], focused = [];
  const snapshot = { ownerPublicId: "ME", serverTime: iso(0), maxBots: 5, bots: [selected], ownListings: [] };
  const result = { snapshot, botId: selected.id, message: "Сохранено", replayed: false };
  const controller = { snapshot, busy: false, loading: false, uncertain: false, error: null, notice: "",
    async command(action) { calls.push(action); return result; }, async refresh() { calls.push("refresh"); }, async retry() { calls.push("retry"); return result; } };
  const props = { controller, online: true, commandsAvailable: true, position: null, readCenter: () => null,
    onChanged: () => changed.push(true), onFocus: circleId => focused.push(circleId), now: NOW };
  return { selected, calls, changed, focused, result, props, controller, h: harness(EarthDevBotsContent, props) };
}
const childControls = view => view.nodes.find(node => node.type === EarthDevBotControls);
const settle = () => new Promise(resolve => setImmediate(resolve));

test("opening controls stays private; explicit map placement requests synthetic bot visibility", () => {
  const f = controls(); let view = f.h.render();
  assert.deepEqual(f.calls, []);
  assert.equal(button(view, "Убрать").props["aria-pressed"], true);
  button(view, "Поставить в центр карты").props.onClick();
  assert.deepEqual(f.calls, [{ action: "set_earth_position", botId: f.bot.id, latitude: 40.7, longitude: -74, accuracyMeters: 20, showOnMap: true }]);
  assert.equal(f.bot.earth.mode, "OFF", "the confirmed snapshot owns visibility, never a local optimistic toggle");
  for (const [label, mode] of [["Обновлять", "SHARING"], ["Призрак", "GHOST"], ["Убрать", "OFF"]]) {
    button(f.h.render(), label).props.onClick();
    assert.deepEqual(f.calls.at(-1), { action: "set_earth_sharing", botId: f.bot.id, mode, precision: "APPROXIMATE", durationMinutes: 60 });
  }
});

test("manual coordinate submission validates decimal commas, zero and accuracy without collecting GPS metadata", () => {
  const f = controls();
  for (const [label, value] of [["Широта", " 0 "], ["Долгота", " -73,5 "], ["Погрешность, м", "12,5"]])
    input(f.h.render(), label).props.onChange({ target: { value } });
  let view = f.h.render(); assert.equal(button(view, "Поставить по координатам").props.disabled, false);
  submit(view, "Поставить по координатам");
  assert.deepEqual(f.calls, [{ action: "set_earth_position", botId: f.bot.id, latitude: 0, longitude: -73.5, accuracyMeters: 12.5 }]);
  for (const value of ["", "NaN", "91", "Infinity"]) {
    input(f.h.render(), "Широта").props.onChange({ target: { value } }); view = f.h.render();
    assert.equal(button(view, "Поставить по координатам").props.disabled, true); submit(view, "Поставить по координатам");
  }
  assert.equal(f.calls.length, 1);
});

test("nearby placement requires fresh private GPS again at the instant of the action", t => {
  t.mock.method(Date, "now", () => NOW);
  const f = controls();
  let view = f.h.render(); assert.equal(button(view, "Поставить рядом со мной").props.disabled, true);
  button(view, "Поставить рядом со мной").props.onClick(); assert.deepEqual(f.calls, []);
  f.props.position = { latitude: 0, longitude: 0, accuracy: 130, timestamp: NOW - 1_000 };
  view = f.h.render(); assert.equal(button(view, "Поставить рядом со мной").props.disabled, false);
  button(view, "Поставить рядом со мной").props.onClick();
  const command = f.calls[0]; assert.equal(command.action, "set_earth_position");
  assert.ok(command.longitude > 0.0017 && command.longitude < 0.0019, "the synthetic point is offset east, not the viewer's exact location");
  assert.equal(command.accuracyMeters, 20);
  assert.deepEqual(Object.keys(command).sort(), ["accuracyMeters", "action", "botId", "latitude", "longitude", "showOnMap"]);
  t.mock.method(Date, "now", () => NOW + 60_001);
  button(view, "Поставить рядом со мной").props.onClick();
  assert.equal(f.calls.length, 1, "a point becoming stale after render cannot be sent");
});

test("publication cooldown blocks every movement path but Ghost permits private synthetic moves", () => {
  const f = controls(); f.bot.earth.mode = "SHARING"; f.bot.earth.nextPublishAt = iso(1_001);
  let view = f.h.render(); assert.match(text(view.tree), /через 2 с/);
  for (const label of ["Поставить в центр карты", "Поставить рядом со мной", "На север на 100 метров", "На запад на 100 метров", "На юг на 100 метров", "На восток на 100 метров", "Поставить по координатам"])
    assert.equal(button(view, label).props.disabled, true, label);
  button(view, "Поставить в центр карты").props.onClick(); button(view, "На север на 100 метров").props.onClick(); submit(view, "Поставить по координатам");
  assert.deepEqual(f.calls, [], "disabled callbacks also enforce the publication interval");
  f.bot.earth.mode = "GHOST"; view = f.h.render();
  assert.match(text(view.tree), /только тестовый GPS/); assert.equal(button(view, "На север на 100 метров").props.disabled, false);
  button(view, "На север на 100 метров").props.onClick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].action, "set_earth_position"); assert.ok(f.calls[0].latitude > point.latitude);
  assert.equal(f.bot.earth.mode, "GHOST");
});

test("mode and precision guards cannot resume an absent or frozen bot through disabled callbacks", () => {
  const f = controls(); f.bot.earth.position = null;
  let view = f.h.render(); assert.equal(button(view, "Обновлять").props.disabled, true);
  button(view, "Обновлять").props.onClick(); assert.deepEqual(f.calls, []);
  f.bot.earth.position = { ...point }; f.bot.earth.mode = "GHOST";
  view = f.h.render(); assert.equal(button(view, "Точно").props.disabled, true);
  button(view, "Точно").props.onClick(); assert.deepEqual(f.calls, []);
  f.bot.earth.mode = "SHARING"; view = f.h.render(); button(view, "Точно").props.onClick();
  assert.deepEqual(f.calls, [{ action: "set_earth_sharing", botId: f.bot.id, mode: "SHARING", precision: "PRECISE", durationMinutes: 60 }]);
});

test("check-ins use an independent cooldown and focus uses only the authorized shared friend binding", () => {
  const f = controls(); f.bot.lastCheckInAt = iso(-29_001); f.bot.earth.mode = "GHOST";
  let view = f.h.render(); assert.equal(button(view, "Отметиться · 1 с").props.disabled, true);
  button(view, "Отметиться · 1 с").props.onClick(); button(view, "Показать").props.onClick();
  assert.deepEqual(f.calls, []); assert.deepEqual(f.focused, []);
  f.props.now = NOW + 999; f.bot.earth.sharedUpdatedAt = iso(-30_000); f.bot.earth.sharedExpiresAt = iso(30_000);
  view = f.h.render(); button(view, "Отметиться").props.onClick(); button(view, "Показать").props.onClick();
  assert.deepEqual(f.calls, [{ action: "check_in", botId: f.bot.id }]); assert.deepEqual(f.focused, [f.bot.circleId]);
});

test("offline and unresolved commands disable controls and guard actions including check-ins", () => {
  const f = controls({ disabled: true }); f.bot.earth.mode = "SHARING"; f.bot.earth.sharedUpdatedAt = iso(-1_000);
  const view = f.h.render();
  for (const node of view.nodes.filter(node => ["button", "input"].includes(node.type))) assert.equal(node.props.disabled, true, text(node));
  for (const label of ["Обновлять", "Призрак", "Убрать", "Поставить в центр карты", "На север на 100 метров", "Точно", "Отметиться", "Показать"])
    button(view, label).props.onClick();
  submit(view, "Поставить по координатам"); assert.deepEqual(f.calls, []); assert.deepEqual(f.focused, []);
});

test("confirmed synthetic point updates replace stale coordinate inputs while timer and unrelated snapshots preserve drafts", () => {
  const f = controls(); input(f.h.render(), "Широта").props.onChange({ target: { value: "12,75" } });
  f.props.now += 1_000; f.bot = f.props.bot = { ...f.bot, displayName: "Другое имя", earth: { ...f.bot.earth, position: { ...point } } };
  assert.equal(input(f.h.render(), "Широта").props.value, "12,75", "a refreshed copy of the same point does not erase typed input");
  f.bot.earth.position = { latitude: -33.9, longitude: 151.2, accuracyMeters: 7 };
  let view = f.h.render();
  assert.equal(input(view, "Широта").props.value, "-33.9"); assert.equal(input(view, "Долгота").props.value, "151.2"); assert.equal(input(view, "Погрешность, м").props.value, "7");
  submit(view, "Поставить по координатам"); assert.deepEqual(f.calls.at(-1), { action: "set_earth_position", botId: f.bot.id, ...f.bot.earth.position });
});

test("map-center placement validates the camera and never sends non-finite or out-of-range positions", () => {
  const f = controls();
  for (const center of [null, { latitude: NaN, longitude: 5 }, { latitude: 91, longitude: 5 }, { latitude: 5, longitude: Infinity }, { latitude: 5, longitude: -181 }]) {
    f.props.readCenter = () => center; button(f.h.render(), "Поставить в центр карты").props.onClick();
  }
  assert.deepEqual(f.calls, []);
  f.props.readCenter = () => ({ latitude: -90, longitude: 180 }); button(f.h.render(), "Поставить в центр карты").props.onClick();
  assert.deepEqual(f.calls, [{ action: "set_earth_position", botId: f.bot.id, latitude: -90, longitude: 180, accuracyMeters: 20, showOnMap: true }]);
});

test("map placement focuses only after a confirmed shared point; a rejected command stays open", async () => {
  for (const confirmed of [false, true]) {
    const f = controls();
    f.props.command = async action => {
      f.calls.push(action);
      return confirmed ? { snapshot: { bots: [{ ...f.bot, earth: { ...f.bot.earth, sharedUpdatedAt: iso(0) } }] } } : null;
    };
    button(f.h.render(), "Поставить в центр карты").props.onClick();
    assert.deepEqual(f.focused, [], "a pending command cannot focus an absent marker");
    await settle();
    assert.deepEqual(f.focused, confirmed ? [f.bot.circleId] : []);
    assert.equal(f.calls[0].showOnMap, true);
  }
});

test("creating and choosing test friends preserves the real selected bot identity and ordinary home level", async () => {
  const f = content(), created = bot("11234567-1234-4123-8123-123456789012");
  f.controller.command = async action => { f.calls.push(action); f.controller.snapshot = { ...f.controller.snapshot, bots: [f.selected, created] }; return { ...f.result, botId: created.id, snapshot: f.controller.snapshot }; };
  input(f.h.render(), "Имя").props.onChange({ target: { value: "  Новый сосед  " } }); submit(f.h.render(), "Создать друга"); await settle();
  assert.deepEqual(f.calls, [{ action: "create", displayName: "Новый сосед", homeLevel: 1 }]); assert.deepEqual(f.changed, [true]);
  let view = f.h.render(); assert.equal(childControls(view).props.bot.id, created.id);
  input(view, "Друг").props.onChange({ target: { value: f.selected.id } }); assert.equal(childControls(f.h.render()).props.bot.id, f.selected.id);
  f.controller.snapshot = { ...f.controller.snapshot, bots: [created] };
  assert.equal(childControls(f.h.render()).props.bot.id, created.id, "deleting a selection falls back to an existing owned bot");
});

test("offline, missing gameplay lease, busy, loading, uncertain and missing snapshots cannot create or send child commands", async () => {
  for (const patch of [{ online: false }, { commandsAvailable: false }, { busy: true }, { loading: true }, { uncertain: true }, { snapshot: null }]) {
    const f = content(); if ("online" in patch || "commandsAvailable" in patch) Object.assign(f.props, patch); else Object.assign(f.controller, patch);
    const view = f.h.render(); assert.equal(button(view, "Создать друга").props.disabled, true); submit(view, "Создать друга");
    const child = childControls(view);
    if (child) { assert.equal(child.props.disabled, true); await child.props.command({ action: "check_in", botId: f.selected.id }); }
    assert.deepEqual(f.calls, [], JSON.stringify(patch)); assert.deepEqual(f.changed, []);
  }
  const f = content(); f.controller.snapshot.bots = Array.from({ length: 5 }, (_, index) => bot(`bot-${index}`));
  assert.equal(button(f.h.render(), "Создать друга"), undefined, "the account limit never offers another creation form");
});

test("lost results expose exact-command retry and notify the map only after a confirmed success", async () => {
  const f = content(); f.controller.uncertain = true; f.controller.error = "Ответ потерян";
  let view = f.h.render(); assert.equal(text(view.nodes.find(node => node.props.role === "alert")), "Ответ потерян");
  assert.equal(button(view, "Проверить прежнюю команду").props.disabled, false);
  await button(view, "Проверить прежнюю команду").props.onClick(); assert.deepEqual(f.calls, ["retry"]); assert.deepEqual(f.changed, [true]);
  f.props.online = false; view = f.h.render(); assert.equal(button(view, "Проверить прежнюю команду").props.disabled, true);
  await button(view, "Проверить прежнюю команду").props.onClick(); assert.equal(f.calls.length, 1);
  f.props.online = true; f.props.commandsAvailable = false; view = f.h.render();
  assert.equal(button(view, "Проверить прежнюю команду").props.disabled, true);
  await button(view, "Проверить прежнюю команду").props.onClick(); assert.equal(f.calls.length, 1, "an unresolved write cannot bypass a missing gameplay lease");
  f.props.commandsAvailable = true; f.controller.retry = async () => null;
  await button(f.h.render(), "Проверить прежнюю команду").props.onClick(); assert.equal(f.changed.length, 1);
});

test("refresh waits for the bot snapshot before notifying the ordinary people and Earth feeds", async () => {
  const f = content(); let finish;
  f.controller.refresh = () => { f.calls.push("refresh"); return new Promise(resolve => { finish = resolve; }); };
  const refreshing = button(f.h.render(), "Обновить").props.onClick();
  assert.deepEqual(f.calls, ["refresh"]); assert.deepEqual(f.changed, []);
  finish(); await refreshing; assert.deepEqual(f.changed, [true]);
});

test("the DEV panel opens with heading focus, isolates Escape and restores trigger focus on close or map focus", () => {
  const f = content(); hooks.setController(f.controller);
  const props = { ...f.props, ownerPublicId: "ME" }, h = harness(EarthDevBots, props);
  let view = h.render(); const trigger = button(view, "DEV Боты");
  assert.equal(trigger.type, "button"); assert.equal(trigger.props["aria-expanded"], false);
  assert.equal(view.nodes.some(node => node.type === "section"), false);
  trigger.props.onClick(); view = h.render();
  const section = view.nodes.find(node => node.type === "section"); assert.equal(section.props.id, trigger.props["aria-controls"]);
  assert.equal(view.nodes.find(node => node.type === "h2").props.tabIndex, -1); assert.equal(h.focus.at(-1).tag, "h2");
  let stopped = false; section.props.onKeyDown({ key: "Enter", stopPropagation() { stopped = true; } }); assert.equal(stopped, false);
  section.props.onKeyDown({ key: "Escape", stopPropagation() { stopped = true; } }); assert.equal(stopped, true);
  assert.equal(h.focus.at(-1).label, "DEV Боты"); assert.equal(button(h.render(), "DEV Боты").props["aria-expanded"], false);
  button(h.render(), "DEV Боты").props.onClick(); view = h.render();
  view.nodes.find(node => node.type === EarthDevBotsContent).props.onFocus(f.selected.circleId);
  assert.deepEqual(f.focused, [f.selected.circleId]); assert.equal(button(h.render(), "DEV Боты").props["aria-expanded"], false);
  assert.deepEqual(hooks.hookRequests().at(-1), { owner: "ME", enabled: false });
});

test("reopening the DEV panel immediately refreshes the clock used by cooldown and private GPS freshness", t => {
  let now = NOW; t.mock.method(Date, "now", () => now);
  const f = content(); hooks.setController(f.controller);
  const h = harness(EarthDevBots, { ...f.props, ownerPublicId: "ME" });
  h.render(); now += 120_000;
  button(h.render(), "DEV Боты").props.onClick();
  let view = h.render(); assert.equal(view.nodes.find(node => node.type === EarthDevBotsContent).props.now, now);
  button(view, "Закрыть тестовых друзей").props.onClick(); h.render(); now += 120_000;
  button(h.render(), "DEV Боты").props.onClick(); view = h.render();
  assert.equal(view.nodes.find(node => node.type === EarthDevBotsContent).props.now, now);
});

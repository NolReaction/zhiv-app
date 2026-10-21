import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { EarthSharingPanel, EarthSharingPanelContent, EarthSharingToggle, sharingSummary } =
  await vite.ssrLoadModule("/features/earth/earth-sharing-panel.tsx");
const { EarthFriendSharingControls } = await vite.ssrLoadModule("/features/earth/earth-friend-sharing.tsx");
const settings = { ownerPublicId: "0000-0000-0001", mode: "OFF", revision: 0, precision: "APPROXIMATE",
  recipientCircleIds: [], frozenCircleIds: [], sharingUntil: null, publicationEpoch: null, serverTime: "2026-10-18T20:00:00Z" };
const friends = [{ circleId: "one", user: { publicId: "0000-0000-0002", displayName: "<script>Лена</script>" }, nickname: "Лена" },
  { circleId: "two", user: { publicId: "0000-0000-0003", displayName: "Дима" } },
  { circleId: "new", user: { publicId: "0000-0000-0004", displayName: "Новый друг" } }];
const activeSettings = { ...settings, mode: "SHARING", revision: 1, recipientCircleIds: ["one", "two"],
  frozenCircleIds: ["two"], sharingUntil: "2026-10-18T21:00:00Z" };

function view(overrides = {}, selection = {}, individual = false) {
  const calls = [];
  const sharing = { settings: { ...settings, ...selection }, pendingGhost: false, pendingPrivacyMode: null,
    publishing: false, lastPublishedAt: null, saving: false, loading: false, error: null,
    refresh: () => calls.push(["refresh"]), ...overrides.sharing };
  const props = { sharing, people: { people: friends }, peopleLoading: false, online: true,
    onShare: async choices => { calls.push(["share", choices]); }, onGhost: () => calls.push(["ghost"]),
    onOff: () => calls.push(["off"]), onOpenPeople: () => calls.push(["people"]), onSetFrozen: async (id, frozen) => { calls.push(["frozen", id, frozen]); return true; },
    onRevokeRecipient: async id => { calls.push(["revoke", id]); return true; },
    draft: { revision: sharing.settings?.revision ?? null, precision: sharing.settings?.precision ?? "APPROXIMATE", durationMinutes: 60 },
    query: "", onQueryChange: value => calls.push(["query", value]),
    onPrecisionChange: value => calls.push(["precision", value]), onDurationChange: value => calls.push(["duration", value]),
    ...overrides, sharing };
  const tree = individual ? createElement("div", null, ...friends.map(person => createElement(EarthFriendSharingControls,
    { key: person.circleId, person, sharing, online: props.online, working: props.working, firstChoices: props.draft,
      onShare: props.onShare, onSetFrozen: props.onSetFrozen, onRevokeRecipient: props.onRevokeRecipient }))) : EarthSharingPanelContent(props);
  const elements = [];
  function walk(node) {
    if (!isValidElement(node)) return;
    if (node.type === EarthSharingToggle) { walk(EarthSharingToggle(node.props)); return; }
    if (node.type === EarthFriendSharingControls) { walk(EarthFriendSharingControls(node.props)); return; }
    elements.push(node); Children.forEach(node.props.children, walk);
  }
  walk(tree);
  return { calls, props, elements, markup: renderToStaticMarkup(tree),
    button: label => elements.find(node => node.type === "button" && node.props["aria-label"] === label),
    textButton: text => elements.find(node => node.type === "button" && Children.toArray(node.props.children).includes(text)) };
}
const friendView = (overrides, selection) => view(overrides, selection, true);
const friendSwitch = (result, name) => result.button("Обновлять геопозицию для " + name);

test("the global panel starts private with a canonical Ghost switch and no People detour", () => {
  const result = view(), toggle = result.button("Режим призрака");
  assert.equal(toggle.props.role, "switch"); assert.equal(toggle.props["aria-checked"], false);
  assert.equal(result.elements.filter(node => node.type === "li").length, 0);
  assert.match(result.markup, /Геопозиция закрыта|Доступ закрыт/); assert.match(result.markup, /Призрак/);
  assert.doesNotMatch(result.markup, /Кому доступно|Выбрать|<script>|Новый друг|Обновлять геопозицию для/);
  assert.match(result.markup, /<input(?=[^>]*value="APPROXIMATE")(?=[^>]*checked)[^>]*>/);
  assert.equal(result.elements.find(node => node.type === "button" && node.props.type === "submit").props.disabled, true);
  assert.ok(result.elements.filter(node => node.type === "details").every(node => !node.props.open));
  assert.deepEqual(result.calls, []);
});

test("the stateful entry point omits private names and preserves saved precise and unlimited choices", () => {
  const result = view({ people: { people: [{ ...friends[0], nickname: null }] } }, { ...activeSettings, precision: "PRECISE", sharingUntil: null });
  const html = renderToStaticMarkup(createElement(EarthSharingPanel, result.props));
  assert.doesNotMatch(html, /Лена|script/);
  assert.match(html, /<input(?=[^>]*value="PRECISE")(?=[^>]*checked)[^>]*>/);
  assert.match(html, /value="forever" selected/);
  assert.deepEqual(result.calls, []);
});

test("a saved paused session resumes only explicitly with the saved audience and frozen preferences", async () => {
  const result = view({}, activeSettings);
  assert.match(result.markup, /Обновление на паузе/); assert.match(result.markup, /Доступ у 2 · обновления разрешены для 1/);
  assert.deepEqual(result.calls, []);
  await result.textButton("Возобновить").props.onClick();
  assert.deepEqual(result.calls, [["share", { recipientCircleIds: ["one", "two"], frozenCircleIds: ["two"], precision: "APPROXIMATE", durationMinutes: 60 }]]);
});

test("the Ghost switch hides immediately and explicitly resumes only previously selected friends", async () => {
  const live = view({ sharing: { publishing: true, lastPublishedAt: settings.serverTime } }, activeSettings);
  const toggle = live.button("Режим призрака"); assert.equal(toggle.props["aria-checked"], false);
  toggle.props.onClick(); assert.deepEqual(live.calls, [["ghost"]]);
  const ghost = view({}, { ...activeSettings, mode: "GHOST" });
  assert.equal(ghost.button("Режим призрака").props["aria-checked"], true);
  await ghost.button("Режим призрака").props.onClick();
  assert.deepEqual(ghost.calls, [["share", { recipientCircleIds: ["one", "two"], frozenCircleIds: ["two"], precision: "APPROXIMATE", durationMinutes: 60 }]]);
});

test("empty and fully frozen audiences never invent recipients or jump to People", () => {
  for (const choices of [{ mode: "OFF" }, { ...activeSettings, frozenCircleIds: ["one", "two"] }]) {
    const result = view({}, choices);
    assert.doesNotMatch(result.markup, /Выбрать|Кому доступно/); assert.deepEqual(result.calls, []);
    result.button("Режим призрака").props.onClick(); assert.deepEqual(result.calls, [["ghost"]]);
  }
});

test("leaving Ghost preserves individual pauses and an empty Ghost account goes OFF without sharing", async () => {
  const result = view({}, { ...activeSettings, mode: "GHOST", frozenCircleIds: ["one", "two"] });
  await result.button("Режим призрака").props.onClick();
  assert.deepEqual(result.calls, [["share", { recipientCircleIds: ["one", "two"], frozenCircleIds: ["one", "two"], precision: "APPROXIMATE", durationMinutes: 60 }]]);
  const empty = view({}, { mode: "GHOST" }); empty.button("Режим призрака").props.onClick();
  assert.deepEqual(empty.calls, [["off"]]);
});

test("an existing friend's switch freezes and unfreezes only that recipient without sharing or GPS consent", async () => {
  const result = friendView({ sharing: { publishing: true, lastPublishedAt: settings.serverTime } }, activeSettings);
  await friendSwitch(result, "Лена").props.onClick();
  await friendSwitch(result, "Дима").props.onClick();
  assert.deepEqual(result.calls, [["frozen", "one", true], ["frozen", "two", false]]);
  const frozen = friendView({}, { ...activeSettings, frozenCircleIds: ["one", "two"] });
  assert.equal(friendSwitch(frozen, "Лена").props["aria-checked"], false);
  assert.match(frozen.markup, /Последнее место/);
  assert.equal(sharingSummary(frozen.props.sharing), "Все на паузе");
});

test("friend rows distinguish live updates, a permitted last point and no access", () => {
  const status = (result, id) => result.elements.find(node => node.props.id === "earth-friend-access-" + id).props.children;
  const live = friendView({ sharing: { publishing: true, lastPublishedAt: settings.serverTime } }, activeSettings);
  assert.equal(sharingSummary(live.props.sharing), "Делюсь гео · 1");
  assert.equal(status(live, "one"), "Обновляется");
  assert.equal(status(live, "two"), "Последнее место");
  assert.equal(status(live, "new"), "Нет доступа");
  const paused = friendView({}, activeSettings);
  assert.equal(status(paused, "one"), "Передача на паузе");
  const ghost = friendView({}, { ...activeSettings, mode: "GHOST" });
  assert.equal(sharingSummary(ghost.props.sharing), "Призрак включён");
  assert.equal(status(ghost, "one"), "Последнее место · призрак");
  assert.equal(status(ghost, "new"), "Нет доступа");
  assert.deepEqual([...live.calls, ...paused.calls, ...ghost.calls], []);
});

test("a never-authorized friend gets consent only from their own explicit switch", async () => {
  const initial = friendView();
  await friendSwitch(initial, "Новый друг").props.onClick();
  assert.deepEqual(initial.calls, [["share", { recipientCircleIds: ["new"], frozenCircleIds: [],
    precision: "APPROXIMATE", durationMinutes: 60 }]]);
  const existing = friendView({}, activeSettings);
  await friendSwitch(existing, "Новый друг").props.onClick();
  assert.deepEqual(existing.calls, [["share", { recipientCircleIds: ["one", "two", "new"], frozenCircleIds: ["two"],
    precision: "APPROXIMATE", durationMinutes: 60 }]]);
});

test("the first consent uses chosen precision and duration without applying an unsaved draft to existing recipients", async () => {
  const draft = { revision: 0, precision: "PRECISE", durationMinutes: null };
  const first = friendView({ draft });
  await friendSwitch(first, "Новый друг").props.onClick();
  assert.deepEqual(first.calls, [["share", { recipientCircleIds: ["new"], frozenCircleIds: [],
    precision: "PRECISE", durationMinutes: null }]]);
  const existing = friendView({ draft }, activeSettings);
  await friendSwitch(existing, "Новый друг").props.onClick();
  assert.deepEqual(existing.calls, [["share", { recipientCircleIds: ["one", "two", "new"], frozenCircleIds: ["two"],
    precision: "APPROXIMATE", durationMinutes: 60 }]]);
});

test("individual revocation stays in People while the map retains explicit revoke-all", async () => {
  const result = friendView({}, activeSettings);
  const controls = result.elements.filter(node => node.type === "button" && Children.toArray(node.props.children).includes("Убрать доступ"));
  assert.equal(controls.length, 2);
  await controls[0].props.onClick();
  assert.deepEqual(result.calls, [["revoke", "one"]]);
  const global = view({}, activeSettings);
  assert.equal(global.textButton("Убрать доступ"), undefined);
  global.textButton("Убрать меня с карты у всех").props.onClick();
  assert.deepEqual(global.calls, [["off"]]);
});

test("Ghost allows revoking a friend's access without resuming sharing or enabling their live switch", async () => {
  const result = friendView({}, { ...activeSettings, mode: "GHOST" });
  const revoke = result.textButton("Убрать доступ");
  assert.equal(revoke.props.disabled, false);
  await revoke.props.onClick();
  assert.equal(friendSwitch(result, "Лена").props.disabled, true);
  assert.deepEqual(result.calls, [["revoke", "one"]]);
});

test("global Ghost keeps individual choices and secondary settings inactive until explicit resume", () => {
  const result = view({}, { ...activeSettings, mode: "GHOST" });
  const individual = friendView({}, { ...activeSettings, mode: "GHOST" });
  for (const person of ["Лена", "Дима", "Новый друг"]) {
    const toggle = friendSwitch(individual, person);
    assert.equal(toggle.props.disabled, true); assert.equal(toggle.props["aria-checked"], false); toggle.props.onClick();
  }
  result.elements.find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.equal(result.elements.find(node => node.type === "button" && node.props.type === "submit").props.disabled, true);
  assert.deepEqual([...result.calls, ...individual.calls], []);
});

test("offline allows immediate Ghost and empty-Ghost OFF while keeping resume disabled and pending honest", () => {
  const offline = view({ online: false, sharing: { publishing: true } }, activeSettings);
  const toggle = offline.button("Режим призрака"); assert.equal(toggle.props.disabled, false); toggle.props.onClick();
  assert.deepEqual(offline.calls, [["ghost"]]);
  const paused = view({ online: false }, { ...activeSettings, mode: "GHOST" });
  assert.equal(paused.button("Режим призрака").props.disabled, true); paused.button("Режим призрака").props.onClick(); assert.deepEqual(paused.calls, []);
  const empty = view({ online: false }, { mode: "GHOST" }); empty.button("Режим призрака").props.onClick(); assert.deepEqual(empty.calls, [["off"]]);
  const pending = view({ online: false, sharing: { pendingGhost: true, pendingPrivacyMode: "GHOST" } }, activeSettings);
  const action = pending.button("Режим призрака"); assert.equal(action.props["aria-checked"], true); assert.equal(action.props.disabled, true);
  action.props.onClick(); assert.deepEqual(pending.calls, []);
  assert.match(pending.markup, /остановлена на устройстве/); assert.match(pending.markup, /Ждём подтверждения сервера/);
});

test("pending OFF is not a confirmed Ghost freeze and cannot enable updates", () => {
  const result = view({ online: false, sharing: { pendingGhost: true, pendingPrivacyMode: "OFF" } });
  assert.match(result.markup, /Удаление доступа ещё не подтверждено сервером/);
  const button = result.button("Режим призрака"); assert.equal(button.props["aria-checked"], false); assert.equal(button.props.disabled, true);
  button.props.onClick(); assert.deepEqual(result.calls, []);
});

test("secondary accuracy and duration only apply on submit and keep frozen recipients", async () => {
  const result = view({ draft: { revision: 1, precision: "PRECISE", durationMinutes: 480 } }, activeSettings);
  assert.deepEqual(result.calls, []);
  await result.elements.find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(result.calls, [["share", { recipientCircleIds: ["one", "two"], frozenCircleIds: ["two"],
    precision: "PRECISE", durationMinutes: 480 }]]);
});

test("pending changes cannot block a privacy stop, while missing settings and global GPS off block resume", () => {
  for (const overrides of [{ sharing: { saving: true } }, { working: true }]) {
    const result = view(overrides, activeSettings), button = result.button("Режим призрака");
    assert.equal(button.props.disabled, false); button.props.onClick(); assert.deepEqual(result.calls, [["ghost"]]);
  }
  for (const overrides of [{ sharing: { settings: null, loading: true } }, { locationAllowed: false }]) {
    const result = view(overrides, { ...activeSettings, mode: "GHOST" }), button = result.button("Режим призрака");
    assert.equal(button.props.disabled, true); button.props.onClick(); assert.deepEqual(result.calls, []);
  }
  const blocked = view({ locationAllowed: false }, activeSettings);
  assert.match(blocked.markup, /Геопозиция отключена в профиле/); blocked.textButton("Возобновить").props.onClick(); assert.deepEqual(blocked.calls, []);
  for (const overrides of [{ sharing: { error: "Сеть недоступна" } }, { localError: "Не удалось сохранить" }]) {
    const failed = view(overrides); assert.match(failed.markup, /role="alert"/);
    failed.button("Обновить настройки геопозиции").props.onClick(); assert.deepEqual(failed.calls, [["refresh"]]);
  }
});

test("many friends do not turn the map settings into a second scrolling roster", () => {
  const people = { people: Array.from({ length: 110 }, (_, index) => ({ circleId: "id-" + index,
    user: { publicId: "person-" + index, displayName: "Друг " + index } })) };
  const result = view({ people });
  assert.equal(result.elements.filter(node => node.type === "li" || node.type === "ul").length, 0);
  assert.equal(result.elements.filter(node => node.type === "input" && node.props.type === "search").length, 0);
  assert.doesNotMatch(result.markup, /Друг 109|Друг 0/);
  assert.equal(result.elements.filter(node => node.type === "button").length, view().elements.filter(node => node.type === "button").length);
  assert.doesNotMatch(result.markup, /Кому доступно|Выбрать получателей/);
  assert.deepEqual(result.calls, []);
});

test("a full audience cannot accidentally authorize a 101st recipient", () => {
  const full = friendView({}, { ...activeSettings, recipientCircleIds: Array.from({ length: 100 }, (_, index) => "chosen-" + index), frozenCircleIds: [] });
  const toggle = friendSwitch(full, "Новый друг");
  assert.equal(toggle.props.disabled, true); toggle.props.onClick();
  assert.deepEqual(full.calls, []);
});

test("a privacy command interrupts an unresolved resume synchronously and failed operations remain actionable", async () => {
  const runtimeId = "virtual:sharing-command-hooks";
  const scoped = await createServer({ appType: "custom", configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
    plugins: [{ name: "sharing-command-runtime", enforce: "pre",
      resolveId(id) { if (id === runtimeId) return "\0" + runtimeId; },
      load(id) { if (id === "\0" + runtimeId) return `
        let slots=[], cursor=0, pending=[];
        export const begin=()=>{cursor=0;pending=[]};
        export function useState(initial){const i=cursor++;if(!(i in slots))slots[i]={value:typeof initial==='function'?initial():initial};return[slots[i].value,v=>{slots[i].value=typeof v==='function'?v(slots[i].value):v}];}
        export function useRef(value){const i=cursor++;if(!(i in slots))slots[i]={ref:{current:value}};return slots[i].ref;}
        export function useEffect(callback){const i=cursor++;if(!(i in slots))pending.push(()=>{slots[i]={cleanup:callback()}});}
        export const commit=()=>pending.forEach(fn=>fn());
        export const dispose=()=>slots.forEach(slot=>slot?.cleanup?.());
      `; },
      transform(source, id) { if (id.endsWith("/features/earth/earth-sharing-panel.tsx")) return source.replace('from "react";', `from "${runtimeId}";`); },
    }] });
  try {
    const runtime = await scoped.ssrLoadModule(runtimeId), { EarthSharingPanel: Panel } = await scoped.ssrLoadModule("/features/earth/earth-sharing-panel.tsx");
    const base = view({}, activeSettings), calls = [];
    let failResume;
    const props = { ...base.props, sharing: { ...base.props.sharing, stopPublishing: () => calls.push("stop") },
      onShare: () => new Promise((resolve, reject) => { failResume = reject; }),
      onGhost: () => { calls.push("ghost"); throw new Error("offline"); }, onOff: async () => { calls.push("off"); throw new Error("retry"); } };
    const render = () => { runtime.begin(); const content = Panel(props); runtime.commit(); return content.props; };
    assert.deepEqual(calls, [], "rendering does not start location or sharing");
    const resume = render().onShare({ recipientCircleIds: ["one"], frozenCircleIds: [], precision: "APPROXIMATE", durationMinutes: 60 });
    assert.equal(render().working, true);
    const stop = render().onGhost();
    assert.deepEqual(calls, ["stop", "ghost"], "publishing stops before a failed privacy transport can complete");
    await stop;
    assert.equal(render().working, false); assert.match(render().localError, /Не удалось сохранить/);
    failResume(new Error("late resume response")); await resume;
    assert.equal(render().working, false); assert.match(render().localError, /Не удалось сохранить/);
    await render().onOff(); assert.deepEqual(calls, ["stop", "ghost", "stop", "off"]);
    assert.match(render().localError, /Не удалось сохранить/);
    let finishGhost;
    props.onGhost = () => { calls.push("pending ghost"); return new Promise(resolve => { finishGhost = resolve; }); };
    const pendingGhost = render().onGhost();
    await render().onOff();
    assert.deepEqual(calls.slice(-4), ["stop", "pending ghost", "stop", "off"], "revoke-all remains available while a weaker Ghost command is unresolved");
    finishGhost(); await pendingGhost;
    assert.equal(render().working, false); assert.match(render().localError, /Не удалось сохранить/);
    runtime.dispose();
  } finally { await scoped.close(); }
});

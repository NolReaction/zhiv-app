import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hooksId = "virtual:earth-editor-view-hooks", walkingId = "virtual:earth-editor-view-walking";
// Exercise the real view, hook and GPS controller; adapt only React scheduling.
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "earth-editor-view-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId || id === walkingId) return `\0${id}`; },
    load(id) {
      if (id === `\0${walkingId}`) return `
        const empty=()=>({status:'idle',route:null,error:null,canRequest:false});
        export const walking={snapshot:empty(),contexts:[],requests:[],clears:0,current:null,accept:true};
        export function reset(){walking.snapshot=empty();walking.contexts.length=0;walking.requests.length=0;walking.clears=0;walking.current=null;walking.accept=true;}
        const request=()=>{walking.requests.push(walking.current);return walking.accept;};
        const clear=()=>{walking.clears++;walking.snapshot=empty();};
        export function useEarthWalkingRoute(context){walking.current=context;walking.contexts.push(context);return{snapshot:walking.snapshot,request,clear};}
      `;
      if (id === `\0${hooksId}`) return `
        export { lazy, Suspense } from "react";
        let current, cursor = 0;
        function slot(create) { const index = cursor++; if (!(index in current.slots)) current.slots[index] = create(); return current.slots[index]; }
        export function create() { return { slots: [], effects: new Set(), pending: new Map(), dirty: false }; }
        export function begin(root) { current = root; cursor = 0; root.dirty = false; }
        export function flush(root) { const work = [...root.pending]; root.pending.clear(); for (const [effect, callback] of work) { effect.cleanup?.(); effect.cleanup = callback(); } }
        export function destroy(root) { for (const effect of root.effects) effect.cleanup?.(); root.effects.clear(); }
        export function useRef(value) { return slot(() => ({ current: value })); }
        export function useState(initial) { const root = current, state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial })); return [state.value, value => { const next = typeof value === 'function' ? value(state.value) : value; if (!Object.is(next, state.value)) { state.value = next; root.dirty = true; } }]; }
        export function useMemo(create, dependencies) { const memo = slot(() => ({ dependencies: undefined, value: undefined })); if (!memo.dependencies || dependencies.some((value, index) => !Object.is(value, memo.dependencies[index]))) { memo.dependencies = dependencies; memo.value = create(); } return memo.value; }
        export function useCallback(callback, dependencies) { return useMemo(() => callback, dependencies); }
        export function useEffect(callback, dependencies) { const root = current, effect = slot(() => ({ dependencies: undefined, cleanup: undefined })); root.effects.add(effect); if (!effect.dependencies || dependencies.some((value, index) => !Object.is(value, effect.dependencies[index]))) { effect.dependencies = dependencies; root.pending.set(effect, callback); } }
        export const useLayoutEffect = useEffect;
        export function useSyncExternalStore(subscribe, getSnapshot) { const root = current; useEffect(() => subscribe(() => { root.dirty = true; }), [subscribe, getSnapshot]); return getSnapshot(); }
      `;
    },
    transform(source, id) {
      if (id.endsWith("/features/earth/earth-view.tsx")) source = source.replace('from "./use-earth-walking-route";', `from "${walkingId}";`);
      if (id.endsWith("/features/earth/earth-view.tsx") || id.endsWith("/features/earth/use-earth-location.ts") || id.endsWith("/features/earth/use-earth-presence.ts")
        || id.endsWith("/features/earth/use-earth-atlas.ts") || id.endsWith("/features/earth/use-earth-atlas-discovery.ts")
        || id.endsWith("/features/earth/use-earth-atlas-explorer.ts"))
        return source.replace('from "react";', `from "${hooksId}";`);
    },
  }],
});
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hooksId);
const { useEarthPresence: renderPresenceHook } = await vite.ssrLoadModule("/features/earth/use-earth-presence.ts");
const { EarthView, EarthFriends } = await vite.ssrLoadModule("/features/earth/earth-view.tsx");
const { EarthMeetCard } = await vite.ssrLoadModule("/features/earth/earth-meet-card.tsx");
const { EarthMap } = await vite.ssrLoadModule("/features/earth/earth-map.tsx");
const { EarthSharingPanel } = await vite.ssrLoadModule("/features/earth/earth-sharing-panel.tsx");
const { EarthAtlasPanel } = await vite.ssrLoadModule("/features/earth/earth-atlas-panel.tsx");
const { EarthAtlasExplorer } = await vite.ssrLoadModule("/features/earth/earth-atlas-explorer.tsx");
const { earthAtlasEntry, EARTH_ATLAS_MEETING_ID } = await vite.ssrLoadModule("/features/earth/earth-atlas.ts");
const { walking, reset: resetWalking } = await vite.ssrLoadModule(walkingId);
const { createEarthWalkingRouteBinding } = await vite.ssrLoadModule("/features/earth/walking-route.ts");
const { getEarthLocationPreferenceStore } = await vite.ssrLoadModule("/features/earth/location-preferences.ts");
const nodes = tree => {
  const result = [];
  const visit = node => { if (isValidElement(node)) { result.push(node); Children.forEach(node.props.children, visit); } };
  visit(tree); return result;
};
const text = node => typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : isValidElement(node) ? text(node.props.children) : "";
let nextOwner = 0;
function setup({ rememberedOpen = false, environment = "development", online = true, permissionState = "prompt" } = {}) {
  resetWalking();
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = environment;
  const globals = new Map(["window", "document", "navigator"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const window = new EventTarget(), document = new EventTarget(), permission = new EventTarget();
  window.isSecureContext = true;
  window.sessionStorage = { getItem: () => rememberedOpen ? "1" : "0" };
  // Each view starts with a readable default-ON preference, independently of
  // earlier tests and their in-memory fallback after a manual lookup.
  const values = new Map();
  window.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  document.visibilityState = "visible"; document.hidden = false; permission.state = permissionState;
  const watches = [], cleared = [], publications = [], actions = [];
  const navigator = { permissions: { query: async () => permission }, geolocation: {
    watchPosition(success, failure) { watches.push({ success, failure }); return watches.length - 1; },
    clearWatch(id) { cleared.push(id); },
  } };
  for (const [name, value] of Object.entries({ window, document, navigator })) Object.defineProperty(globalThis, name, { value, configurable: true });
  const sharing = { settings: { mode: "SHARING", recipientCircleIds: ["friend-one"] }, pendingGhost: false, publishing: false,
    lastPublishedAt: "2026-10-19T00:00:00Z", people: [{ circleId: "friend-one", user: { displayName: "Лена" } }],
    setPosition: value => publications.push(value), stopPublishing: () => actions.push("stopPublishing"),
    ghost: () => actions.push("ghost"), off: () => actions.push("off"), refresh() {}, share: async () => true };
  const props = { ownerPublicId: `owner-test-${++nextOwner}`, active: true, visible: true, sharing, isOnline: online,
    people: null, peopleLoading: false, peopleError: null, onRefreshPeople() {}, onOpenPeople() {}, onOpenWorld() {} };
  let state = hooks.create(), owner = props.ownerPublicId, editing = environment === "development" && rememberedOpen;
  props.onModelEditingChange = value => { editing = value; state.dirty = true; };
  function render() {
    if (owner !== props.ownerPublicId) { hooks.destroy(state); state = hooks.create(); owner = props.ownerPublicId; }
    let tree, passes = 0;
    do { hooks.begin(state); props.location = renderPresenceHook({ ownerPublicId: props.ownerPublicId, enabled: props.active, mapVisible: props.visible, temporarilyPaused: editing, sharing: props.sharing }); const session = EarthView(props); tree = session.type(session.props); hooks.flush(state); assert.ok(++passes < 15, "view settles"); } while (state.dirty);
    const all = nodes(tree);
    return { tree, all, map: all.find(node => node.type === EarthMap).props, text: text(tree) };
  }
  return { render, props, watches, cleared, publications, actions, document,
    destroy() {
      hooks.destroy(state);
      process.env.NODE_ENV = originalEnv;
      for (const [name, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
    },
  };
}
const fix = timestamp => ({ coords: { longitude: 2.29, latitude: 48.85, accuracy: 15 }, timestamp });

test("opening DEV3D removes social/GPS overlays, pauses a live private watch and resumes it on close", () => {
  const app = setup();
  try {
    let view = app.render();
    assert.match(view.text, /На карте/);
    view.map.onLocate(); app.render();
    app.watches[0].success(fix(1000)); view = app.render();
    assert.equal(view.map.position.timestamp, 1000);
    assert.equal(view.map.friends.length, 1);
    view.map.onModelEditorOpenChange(true); view = app.render();
    assert.deepEqual(app.cleared, [0]);
    assert.equal(view.map.position, null);
    assert.equal(view.map.showLocationControl, false);
    assert.equal(view.map.locationDetails, null);
    assert.deepEqual(view.map.friends, []);
    assert.doesNotMatch(view.text, /На карте|Ожидаем GPS|Делюсь|Только я/);
    assert.deepEqual(app.actions, [], "temporary pause does not revoke publication or consent");
    assert.equal(app.publications.at(-1), null);
    app.watches[0].failure({ code: 3 });
    view = app.render();
    assert.equal(view.map.locationStatus, "paused");
    assert.equal(app.watches.length, 1, "a late hidden watch error cannot start a fallback");
    view.map.onModelEditorOpenChange(false); view = app.render();
    assert.equal(app.watches.length, 2);
    assert.match(view.text, /На карте/);
    assert.equal(view.map.showLocationControl, true);
    assert.equal(view.map.friends.length, 1);
    app.watches[1].success(fix(2000)); view = app.render();
    assert.equal(view.map.position.timestamp, 2000);
    assert.deepEqual(app.actions, []);
    app.watches[1].failure({ code: 3 }); view = app.render();
    assert.equal(app.watches.length, 3, "a foreground provider failure gets one high-accuracy retry");
    assert.equal(view.map.locationStatus, "requesting");
    assert.equal(app.publications.at(-1), null, "a retained old fix is never published while retrying");
    assert.deepEqual(app.actions, [], "the bounded retry is still acquiring a private fix");
    app.watches[2].failure({ code: 3 }); view = app.render();
    assert.match(view.text, /Не удалось дождаться геопозиции после повторного поиска/);
    assert.equal(view.map.position.timestamp, 2000, "a temporary failure retains the last private fix");
    assert.equal(view.map.locationStatus, "timeout");
    assert.deepEqual(app.actions, ["stopPublishing"], "real GPS failures still stop publishing outside the editor");
  } finally { app.destroy(); }
});

test("publication expiry during editing does not discard the paused private GPS request", () => {
  const app = setup(); app.props.sharing.publishing = true;
  try {
    let view = app.render(); view.map.onLocate(); app.render(); app.watches[0].success(fix(1000)); view = app.render();
    view.map.onModelEditorOpenChange(true); app.render();
    app.props.sharing = { ...app.props.sharing, publishing: false };
    view = app.render(); view.map.onModelEditorOpenChange(false); app.render();
    assert.equal(app.watches.length, 2);
    app.watches[1].success(fix(2000)); view = app.render();
    assert.equal(view.map.position.timestamp, 2000);
    assert.deepEqual(app.actions, []);
  } finally { app.destroy(); }
});

test("remembered development editor state is private before lazy mounting and production ignores it", () => {
  for (const environment of ["development", "production"]) {
    const app = setup({ rememberedOpen: true, environment, online: false });
    try {
      const view = app.render();
      assert.equal(view.map.showLocationControl, environment === "production");
      if (environment === "development") assert.doesNotMatch(view.text, /На карте|Нет сети/);
      else { assert.match(view.text, /На карте/); assert.match(view.text, /Нет сети/); }
      assert.equal(app.watches.length, environment === "production" ? 1 : 0,
        "the remembered DEV editor blocks GPS; production opens the normal map and its private lookup");
      assert.equal(view.map.position, null);
      assert.ok(app.publications.every(position => position === null), "map entry alone has no fresh coordinate to publish");
    } finally { app.destroy(); }
  }
});

test("a retained tab round trip keeps the granted private marker, pauses GPS and rejects callbacks from the old watch", async () => {
  const app = setup({ permissionState: "granted" }); app.props.sharing.publishing = false;
  try {
    app.render(); for (let index = 0; index < 6; index++) await Promise.resolve();
    assert.equal(app.watches.length, 1, "already granted permission starts the initial private lookup without a click");
    app.render(); app.watches[0].success(fix(1000)); let view = app.render();
    const privatePoint = view.map.position;
    app.props.visible = false; view = app.render();
    assert.equal(view.map.position, null, "a hidden view receives no own marker projection");
    assert.deepEqual(app.cleared, [0]); assert.equal(app.publications.at(-1), null);
    app.watches[0].success(fix(9000)); app.watches[0].failure({ code: 1 }); app.render();
    app.props.visible = true; view = app.render();
    assert.equal(view.map.position, privatePoint, "the retained marker returns before any new browser fix");
    assert.equal(app.watches.length, 2, "only the earlier requested private watch resumes");
    assert.equal(view.map.locating, true); assert.equal(view.map.locationActive, false);
    assert.match(text(view.map.locationDetails), /Определяем местоположение/);
    assert.equal(app.publications.at(-1), null, "the old fix is not presented to sharing as a fresh active position");
    app.watches[0].success(fix(20_000)); view = app.render(); assert.equal(view.map.position, privatePoint);
    app.watches[1].success(fix(2000)); view = app.render();
    assert.equal(view.map.position.timestamp, 2000); assert.equal(view.map.locationActive, true);
    app.destroy(); assert.deepEqual(app.cleared, [0, 1]);
  } catch (error) { app.destroy(); throw error; }
});

test("stopping public sharing outside the map retains its private marker without restarting GPS on return", () => {
  const app = setup(); app.props.sharing.publishing = true;
  try {
    let view = app.render(); view.map.onLocate(); app.render(); app.watches[0].success(fix(1000)); view = app.render();
    const privatePoint = view.map.position;
    app.props.visible = false; app.render(); assert.deepEqual(app.actions, [], "app navigation keeps consenting publication alive");
    app.props.sharing = { ...app.props.sharing, publishing: false }; app.render();
    app.props.visible = true; view = app.render();
    assert.equal(view.map.position, privatePoint); assert.equal(app.watches.length, 1);
    assert.equal(view.map.locationActive, false); assert.equal(view.map.locating, false);
    assert.match(text(view.map.locationDetails), /Последняя геопозиция · обновление остановлено/);
    assert.equal(app.publications.at(-1), null);
    view.map.onLocate(); app.render(); assert.equal(app.watches.length, 2, "a fresh private lookup still requires an explicit action after freeze");
  } finally { app.destroy(); }
});

const sharingPanel = view => view.all.find(node => node.type === EarthSharingPanel);
const privacyClose = view => view.all.find(node => node.type === "button" && node.props["aria-label"] === "Закрыть настройки геопозиции");

test("People privacy requests open and acknowledge once, while acknowledgement removal and later tab returns preserve user panel choices", () => {
  const app = setup(), acknowledged = [];
  app.props.privacyRequest = 1; app.props.onPrivacyRequestHandled = value => acknowledged.push(value);
  try {
    let view = app.render(); assert.ok(sharingPanel(view)); assert.deepEqual(acknowledged, [1]);
    const entryWatches = app.watches.length;
    assert.equal(entryWatches, 1, "visible map entry starts its private lookup");
    app.props.privacyRequest = null; view = app.render(); assert.ok(sharingPanel(view), "parent ACK removal does not close the panel");
    view = app.render(); assert.deepEqual(acknowledged, [1]);
    privacyClose(view).props.onClick(); view = app.render(); assert.equal(sharingPanel(view), undefined);
    assert.equal(app.watches.length, entryWatches, "opening, acknowledging and closing settings do not add a GPS lookup");
    app.props.visible = false; app.render();
    assert.equal(app.watches.length, entryWatches, "a hidden map cannot start GPS");
    assert.deepEqual(app.cleared, [0]);
    app.props.visible = true; view = app.render();
    const returnedWatches = app.watches.length;
    assert.equal(returnedWatches, entryWatches + 1, "returning resumes only the earlier private request");
    assert.equal(sharingPanel(view), undefined, "an ordinary map return does not replay the consumed request");
    app.props.privacyRequest = 2; view = app.render(); assert.ok(sharingPanel(view)); assert.deepEqual(acknowledged, [1, 2]);
    app.props.privacyRequest = null; view = app.render(); assert.ok(sharingPanel(view));
    assert.equal(app.watches.length, returnedWatches, "another settings request does not add a GPS lookup");
    assert.ok(app.publications.every(position => position === null), "read-only settings never publish a coordinate");
  } finally { app.destroy(); }
});

test("a People privacy request received by a retained hidden view waits until that view becomes visible", () => {
  const app = setup(), acknowledged = []; app.props.visible = false;
  app.props.onPrivacyRequestHandled = value => acknowledged.push(value);
  try {
    app.render(); app.props.privacyRequest = 3; let view = app.render();
    assert.equal(sharingPanel(view), undefined); assert.deepEqual(acknowledged, []);
    app.props.visible = true; view = app.render(); assert.ok(sharingPanel(view)); assert.deepEqual(acknowledged, [3]);
    app.props.privacyRequest = null; view = app.render(); assert.ok(sharingPanel(view));
    app.props.visible = false; app.render(); app.props.visible = true; view = app.render();
    assert.equal(sharingPanel(view), undefined); assert.deepEqual(acknowledged, [3]);
  } finally { app.destroy(); }
});

test("a People privacy request waits for an open DEV3D editor to close before showing settings and acknowledging", () => {
  const app = setup({ rememberedOpen: true }), acknowledged = [];
  app.props.onPrivacyRequestHandled = value => acknowledged.push(value);
  try {
    let view = app.render(); assert.equal(view.map.showLocationControl, false);
    assert.equal(app.watches.length, 0, "the remembered editor blocks GPS before its lazy mount");
    app.props.privacyRequest = 4; view = app.render();
    assert.equal(view.map.showLocationControl, false, "a privacy shortcut never closes an unsaved editor");
    assert.equal(sharingPanel(view), undefined); assert.deepEqual(acknowledged, []);
    assert.equal(app.watches.length, 0, "a privacy request cannot bypass the open editor's GPS gate");
    view.map.onModelEditorOpenChange(false); view = app.render();
    assert.ok(sharingPanel(view)); assert.deepEqual(acknowledged, [4]);
    assert.equal(app.watches.length, 1, "closing the editor reveals the map and starts its initial private lookup");
    app.props.privacyRequest = null; view = app.render(); assert.ok(sharingPanel(view));
    assert.equal(app.watches.length, 1, "acknowledging settings never starts an additional lookup");
    assert.ok(app.publications.every(position => position === null));
  } finally { app.destroy(); }
});


test("a single friend marker opens the meeting card, while a grouped marker opens the compact roster without another GPS acquisition", () => {
  const app = setup();
  try {
    let view = app.render();
    const entryWatches = app.watches.length;
    assert.equal(entryWatches, 1, "visible map entry starts its private lookup");
    view.map.onSelectFriends(["friend-one", "friend-two"]); view = app.render();
    assert.ok(view.all.some(node => node.type === EarthFriends));
    assert.equal(view.all.some(node => node.type === EarthMeetCard), false);
    assert.equal(app.watches.length, entryWatches, "opening a group does not add an own-location lookup");
    view.map.onSelectFriends(["friend-one"]); view = app.render();
    assert.equal(view.all.some(node => node.type === EarthFriends), false);
    const meeting = view.all.find(node => node.type === EarthMeetCard);
    assert.ok(meeting); assert.equal(meeting.props.person.circleId, "friend-one");
    assert.equal(view.map.meetCircleId, "friend-one");
    assert.equal(app.watches.length, entryWatches, "the friend-marker action reuses the pending private lookup");
    assert.ok(app.publications.every(position => position === null));
    assert.doesNotMatch(view.text, /Игровой профиль|В гости|Подойти к другу/);
  } finally { app.destroy(); }
});

test("selecting a group member starts one explicit private lookup when GHOST or READY suppresses map auto-start", () => {
  for (const mode of ["ghost", "ready"]) {
    const app = setup();
    if (mode === "ghost") app.props.sharing = { ...app.props.sharing, settings: { ...app.props.sharing.settings, mode: "GHOST" }, publishing: false };
    else {
      const preference = getEarthLocationPreferenceStore(app.props.ownerPublicId);
      preference.setEnabled(false); preference.setEnabled(true);
    }
    try {
      let view = app.render();
      assert.equal(app.watches.length, 0, `${mode}: map auto-start remains suppressed`);
      view.map.onSelectFriends(["friend-one", "friend-two"]); view = app.render();
      assert.ok(view.all.some(node => node.type === EarthFriends));
      assert.equal(app.watches.length, 0, "opening the roster does not request private GPS");
      view.map.onSelectFriends(["friend-one"]); view = app.render();
      assert.equal(view.all.find(node => node.type === EarthMeetCard).props.person.circleId, "friend-one");
      assert.equal(app.watches.length, 1, "the deliberate meeting selection starts the missing private lookup");
      view.map.onSelectFriends(["friend-one"]); app.render();
      assert.equal(app.watches.length, 1, "the pending explicit lookup is reused");
      assert.deepEqual(app.actions, [], "private lookup does not change sharing consent");
      assert.ok(app.publications.every(position => position === null));
    } finally { app.destroy(); }
  }
});


test("selecting a member of a co-located map group opens that meeting without waiting for the marker to split", () => {
  const app = setup();
  let originFocus = 0;
  const groupTrigger = { isConnected: true, disabled: false, focus() { originFocus++; } };
  const point = { latitude: 55.75, longitude: 37.62, accuracyMeters: 20, precision: "PRECISE",
    updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), expiresAtMonotonic: performance.now() + 60_000 };
  app.props.sharing.people = [
    { ...point, circleId: "friend-one", user: { publicId: "ONE", displayName: "Лена" } },
    { ...point, circleId: "friend-two", user: { publicId: "TWO", displayName: "Дима" } },
  ];
  try {
    let view = app.render();
    const entryWatches = app.watches.length;
    assert.equal(entryWatches, 1, "visible map entry starts its private lookup");
    view.map.onSelectFriends(["friend-one", "friend-two"], groupTrigger); view = app.render();
    const roster = view.all.find(node => node.type === EarthFriends);
    assert.ok(roster); assert.equal(app.watches.length, entryWatches, "the roster does not add a lookup");
    const member = nodes(EarthFriends(roster.props)).find(node => node.type === "button" && node.props["aria-label"] === "Открыть встречу: Дима");
    assert.ok(member); member.props.onClick(); view = app.render();
    assert.equal(view.all.find(node => node.type === EarthMeetCard).props.person.circleId, "friend-two");
    assert.equal(view.map.meetCircleId, "friend-two");
    assert.equal(view.map.friendFocusRequest.circleId, "friend-two", "the selected friend is framed above the meeting independently of own GPS");
    assert.equal(view.map.meetFocusRequest, 0, "a marker tap does not start framing both locations");
    assert.equal(app.watches.length, entryWatches, "selecting a member reuses the map's pending private lookup");
    view.all.find(node => node.type === EarthMeetCard).props.onClose(); view = app.render();
    assert.equal(originFocus, 1, "a grouped meeting returns focus to its map marker");
    view.all.find(node => node.type === "button" && node.props["aria-label"] === "Участники на карте: 2").props.onClick(); view = app.render();
    const fullRoster = view.all.find(node => node.type === EarthFriends);
    const focus = nodes(EarthFriends(fullRoster.props)).find(node => node.type === "button" && node.props["aria-label"] === "Открыть встречу: Лена");
    assert.ok(focus, "the compact map picker opens a meeting directly"); focus.props.onClick(); view = app.render();
    assert.equal(view.map.friendFocusRequest.circleId, "friend-one");
    assert.equal(view.all.find(node => node.type === EarthMeetCard).props.person.circleId, "friend-one");
    assert.equal(app.watches.length, entryWatches, "switching meetings never duplicates the pending lookup");
    assert.ok(app.publications.every(position => position === null));
    view.all.find(node => node.type === EarthMeetCard).props.onClose();
    assert.equal(originFocus, 1, "a new meeting from the general picker never focuses the previous marker");
  } finally { app.destroy(); }
});

const atlasPanel = view => view.all.find(node => node.type === EarthAtlasPanel);
const explorerCard = view => view.all.find(node => node.type === EarthAtlasExplorer);
const book = view => view.all.find(node => node.type === "button" && node.props["aria-label"] === "Личный атлас");
const preview = (view, status = "ready") => ({ entryId: view.map.cameraFocusRequest.entryId,
  requestId: view.map.cameraFocusRequest.requestId, status });

test("catalogue Close and Escape restore book focus only after commit, without stealing focus from another panel", () => {
  for (const action of ["close", "escape", "replaced", "hidden"]) {
    const app = setup();
    try {
      let view = app.render(); book(view).props.onClick(); view = app.render();
      let focused = 0;
      book(view).props.ref.current = { focus() { focused++; } };
      if (action === "escape") view.all.find(node => node.props.id === "earth-atlas-panel").props.onKeyDown({ key: "Escape", stopPropagation() {} });
      else view.all.find(node => node.type === "button" && node.props["aria-label"] === "Закрыть атлас").props.onClick();
      assert.equal(focused, 0, "the trigger is still hidden until the catalogue closes in short landscape");
      if (action === "replaced") app.props.privacyRequest = 31;
      if (action === "hidden") app.props.visible = false;
      app.render();
      assert.equal(focused, action === "close" || action === "escape" ? 1 : 0, action);
      app.render();
      assert.equal(focused, action === "close" || action === "escape" ? 1 : 0, "no delayed second focus");
    } finally { app.destroy(); }
  }
});

test("atlas catalogue choices close the sheet and only an explicitly ready current frame can be saved", () => {
  const app = setup();
  try {
    let view = app.render(); book(view).props.onClick(); view = app.render();
    const atlas = atlasPanel(view).props.atlas, eiffel = earthAtlasEntry("landmark:eiffel-tower");
    atlasPanel(view).props.onFocus(eiffel); view = app.render();
    assert.equal(atlasPanel(view), undefined); assert.equal(explorerCard(view).props.entry, eiffel);
    assert.equal(view.map.cameraFocusRequest.entryId, eiffel.id);
    assert.deepEqual(atlas.readSnapshot().ids, [], "selection and focus never save");
    explorerCard(view).props.onDiscover(); assert.deepEqual(atlas.readSnapshot().ids, []);
    view.map.onAtlasPreviewChange(preview(view)); view = app.render();
    const staleSave = explorerCard(view).props.onDiscover;
    view.map.onAtlasPreviewChange(preview(view, "moving"));
    staleSave(); assert.deepEqual(atlas.readSnapshot().ids, [], "movement closes the guard before a React update");
    view.map.onAtlasPreviewChange(preview(view)); view = app.render();
    app.document.hidden = true; explorerCard(view).props.onDiscover(); assert.deepEqual(atlas.readSnapshot().ids, []);
    app.document.hidden = false; explorerCard(view).props.onDiscover(); view = app.render();
    assert.deepEqual(atlas.readSnapshot().ids, [eiffel.id]); assert.equal(explorerCard(view).props.opened, true);
    assert.equal(view.all.some(node => node.props.discovery?.entry.id === eiffel.id), false, "there is no second floating discovery panel");
  } finally { app.destroy(); }
});

test("catalogue reopen preserves the selected place and invalidates covered or superseded Save callbacks", () => {
  const app = setup();
  try {
    let view = app.render(); book(view).props.onClick(); view = app.render();
    const atlas = atlasPanel(view).props.atlas, eiffel = earthAtlasEntry("landmark:eiffel-tower"), giza = earthAtlasEntry("landmark:giza-pyramids");
    assert.equal(atlasPanel(view).props.onStartJourney, undefined, "the visible catalogue has no route commands");
    atlasPanel(view).props.onFocus(eiffel); view = app.render();
    const first = view.map.cameraFocusRequest;
    view.map.onAtlasPreviewChange(preview(view)); view = app.render();
    const oldSave = explorerCard(view).props.onDiscover;
    book(view).props.onClick(); oldSave();
    assert.deepEqual(atlas.readSnapshot().ids, [], "opening the catalogue closes the Save guard synchronously");
    view = app.render(); assert.equal(explorerCard(view), undefined);
    assert.equal(atlasPanel(view).props.onSelectStop, undefined);
    view.map.onAtlasPreviewChange(preview(view)); oldSave(); assert.deepEqual(atlas.readSnapshot().ids, []);
    view.all.find(node => node.type === "button" && node.props["aria-label"] === "Закрыть атлас").props.onClick(); view = app.render();
    assert.equal(explorerCard(view).props.entry.id, eiffel.id);
    assert.equal(view.map.cameraFocusRequest.requestId, first.requestId, "closing the catalogue cannot restart the camera");
    book(view).props.onClick(); view = app.render(); atlasPanel(view).props.onFocus(giza); view = app.render();
    assert.equal(atlasPanel(view), undefined); assert.equal(explorerCard(view).props.entry.id, giza.id);
    assert.ok(view.map.cameraFocusRequest.requestId > first.requestId);
    oldSave(); assert.deepEqual(atlas.readSnapshot().ids, [], "the previous place cannot be saved through an old callback");
    view.map.onAtlasPreviewChange(preview(view)); view = app.render(); explorerCard(view).props.onDiscover();
    assert.deepEqual(atlas.readSnapshot().ids, [giza.id]);
  } finally { app.destroy(); }
});

test("Explorer Escape closes the place, clears camera intent and returns keyboard focus to the book", () => {
  const app = setup();
  try {
    let view = app.render();
    const entryWatches = app.watches.length;
    assert.equal(entryWatches, 1, "visible map entry starts its private lookup");
    book(view).props.onClick(); view = app.render();
    atlasPanel(view).props.onFocus(earthAtlasEntry("landmark:eiffel-tower")); view = app.render();
    let focused = 0, stopped = 0; book(view).props.ref.current = { focus() { focused++; } };
    view.tree.props.onKeyDown({ key: "Escape", stopPropagation() { stopped++; } }); view = app.render();
    assert.equal(explorerCard(view), undefined); assert.equal(view.map.cameraFocusRequest, null);
    assert.equal(focused, 1); assert.equal(stopped, 1);
    book(view).props.onClick(); view = app.render(); assert.equal(atlasPanel(view).props.journeyState, undefined);
    assert.equal(app.watches.length, entryWatches, "browsing places never adds a GPS lookup");
    assert.ok(app.publications.every(position => position === null));
  } finally { app.destroy(); }
});

test("privacy, editor, hidden view and owner replacement invalidate the explorer without resuming stale camera intent", () => {
  for (const cover of ["privacy", "editor", "hidden", "owner"]) {
    const app = setup();
    try {
      let view = app.render(); book(view).props.onClick(); view = app.render();
      const atlas = atlasPanel(view).props.atlas, entry = earthAtlasEntry("landmark:eiffel-tower");
      atlasPanel(view).props.onFocus(entry); view = app.render(); view.map.onAtlasPreviewChange(preview(view)); view = app.render();
      const oldSave = explorerCard(view).props.onDiscover, oldPreview = preview(view), report = view.map.onAtlasPreviewChange;
      if (cover === "privacy") app.props.privacyRequest = 91;
      if (cover === "editor") view.map.onModelEditorOpenChange(true);
      if (cover === "hidden") app.props.visible = false;
      if (cover === "owner") app.props.ownerPublicId = "replacement-owner";
      view = app.render(); report(oldPreview); oldSave();
      assert.deepEqual(atlas.readSnapshot().ids, [], cover);
      assert.equal(view.map.cameraFocusRequest, null, cover);
      assert.equal(explorerCard(view), undefined, cover);
    } finally { app.destroy(); }
  }
});

test("an explicit fresh friend meeting keeps its GPS guard and saves without any atlas preview", () => {
  const app = setup();
  const now = Date.now();
  app.props.sharing.people = [{ circleId: "friend-one", user: { publicId: "ONE", displayName: "Лена" },
    latitude: 48.85, longitude: 2.29, accuracyMeters: 15, precision: "PRECISE", updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(), expiresAtMonotonic: performance.now() + 60_000 }];
  try {
    let view = app.render(); book(view).props.onClick(); view = app.render(); const atlas = atlasPanel(view).props.atlas;
    view.all.find(node => node.type === "button" && node.props["aria-label"] === "Закрыть атлас").props.onClick(); view = app.render();
    view.map.onSelectFriends(["friend-one"]); app.render(); app.watches[0].success(fix(Date.now())); view = app.render();
    assert.equal(view.map.cameraFocusRequest, null); assert.equal(explorerCard(view), undefined);
    const meeting = view.all.find(node => node.type === EarthMeetCard);
    assert.ok(meeting); assert.deepEqual(atlas.readSnapshot().ids, []);
    meeting.props.onRecordMeeting();
    assert.deepEqual(atlas.readSnapshot().ids, [EARTH_ATLAS_MEETING_ID]);
  } finally { app.destroy(); }
});


function freshWalkingFriend() {
  const now = Date.now();
  return { circleId: "friend-one", user: { publicId: "ONE", displayName: "Лена" }, latitude: 48.851, longitude: 2.291,
    accuracyMeters: 15, precision: "PRECISE", updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(), expiresAtMonotonic: performance.now() + 60_000 };
}

test("meeting routes are requested explicitly, frame only accepted builds and forward the actual ready path", () => {
  const app = setup(); app.props.sharing.people = [freshWalkingFriend()];
  try {
    let view = app.render(); assert.equal(walking.requests.length, 0); assert.equal(view.map.walkingRoute, null);
    view.map.onSelectFriends(["friend-one"]); view = app.render();
    assert.equal(walking.requests.length, 0, "opening a friend never requests the routing provider");
    assert.equal(walking.current.owner, app.props.ownerPublicId); assert.equal(walking.current.person.circleId, "friend-one");
    assert.equal(walking.current.position, null, "a private GPS request is not already a fresh routing endpoint");
    app.watches[0].success(fix(Date.now())); view = app.render();
    assert.equal(walking.current.position, view.map.position); assert.equal(walking.current.allowed, true); assert.equal(walking.current.foreground, true);
    let meeting = view.all.find(node => node.type === EarthMeetCard);
    walking.accept = false; meeting.props.onBuildWalkingRoute(); view = app.render();
    assert.equal(walking.requests.length, 1); assert.equal(view.map.meetFocusRequest, 0, "a refused build cannot pan the camera");
    walking.accept = true; meeting = view.all.find(node => node.type === EarthMeetCard); meeting.props.onBuildWalkingRoute(); view = app.render();
    assert.equal(walking.requests.length, 2); assert.equal(view.map.meetFocusRequest, 1);
    const binding = createEarthWalkingRouteBinding(app.props.ownerPublicId, view.map.position, walking.current.person, performance.now(), Date.now());
    assert.ok(binding);
    const route = { ...binding, geometry: { type: "LineString", coordinates: [binding.origin, binding.destination] }, distanceMeters: 2350, durationSeconds: 1060 };
    walking.snapshot = { status: "ready", route, error: null, canRequest: false }; view = app.render();
    meeting = view.all.find(node => node.type === EarthMeetCard);
    assert.equal(meeting.props.walkingRoute, walking.snapshot); assert.equal(view.map.walkingRoute, route);
    assert.equal(walking.requests.length, 2, "a ready snapshot or rerender does not refresh the route");
    meeting.props.onClearWalkingRoute(); view = app.render();
    assert.equal(walking.clears, 1); assert.equal(view.map.walkingRoute, null);
    assert.equal(view.all.find(node => node.type === EarthMeetCard).props.walkingRoute.route, null);
  } finally { app.destroy(); }
});

test("hidden views, editor and another panel disable routing context and immediately hide any retained route prop", () => {
  for (const cover of ["hidden", "editor", "privacy"]) {
    const app = setup(); app.props.sharing.people = [freshWalkingFriend()];
    try {
      let view = app.render(); view.map.onSelectFriends(["friend-one"]); app.render(); app.watches[0].success(fix(Date.now())); view = app.render();
      walking.snapshot = { status: "ready", route: { geometry: { type: "LineString", coordinates: [[2.29, 48.85], [2.291, 48.851]] } }, error: null, canRequest: false };
      view = app.render(); assert.ok(view.map.walkingRoute);
      if (cover === "hidden") app.props.visible = false;
      if (cover === "editor") view.map.onModelEditorOpenChange(true);
      if (cover === "privacy") app.props.privacyRequest = 170;
      view = app.render();
      assert.equal(view.map.walkingRoute, null, cover); assert.equal(walking.current.foreground, false, cover);
      assert.equal(walking.requests.length, 0, "availability changes cannot create provider requests");
    } finally { app.destroy(); }
  }
});

test("global GPS off retains the Ghost settings panel and passes an ineligible routing context without a lookup", () => {
  const app = setup(); app.props.ownerPublicId = "gps-off-settings-owner";
  const preference = getEarthLocationPreferenceStore(app.props.ownerPublicId); preference.setEnabled(false);
  app.props.privacyRequest = 171;
  try {
    const view = app.render(), panel = sharingPanel(view);
    assert.ok(panel, "the global off state must not replace or hide the Ghost controls");
    assert.equal(panel.props.locationAllowed, false); assert.equal(walking.current.allowed, false); assert.equal(walking.current.position, null);
    assert.equal(view.map.walkingRoute, null); assert.equal(app.watches.length, 0); assert.equal(walking.requests.length, 0);
  } finally { app.destroy(); }
});

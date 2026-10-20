import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children, isValidElement } from "react";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hooksId = "virtual:earth-audio-hooks", runtimeId = "virtual:earth-audio-runtime";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "earth-audio-actions", enforce: "pre",
    resolveId(id) { if ([hooksId, runtimeId].includes(id)) return "\0" + id; },
    load(id) {
      if (id === "\0" + runtimeId) return "export const events=[];const runtime={play:event=>events.push(event)};export const getAudioRuntime=()=>runtime;";
      if (id === "\0" + hooksId) return `
        export { lazy, Suspense } from "react";
        let phase = "ready";
        export const setPhase=value=>{phase=value};
        export const useRef=value=>({current:value});
        export const useEffect=()=>{};
        export const useLayoutEffect=()=>{};
        export const useCallback=callback=>callback;
        export const useState=initial=>{const value=typeof initial==="function"?initial():initial;return [value==="loading"?phase:value,()=>{}]};
        export const useSyncExternalStore=(subscribe,snapshot)=>snapshot();
      `;
    },
    transform(source, id) {
      if (/\/features\/earth\/(earth-map|earth-sharing-panel|earth-friend-sharing|earth-meet-card)\.tsx$/.test(id)) {
        source = source.replace('from "@/features/audio/runtime/audio-service";', `from "${runtimeId}";`);
        if (!id.endsWith("earth-sharing-panel.tsx")) source = source.replace('from "react";', `from "${hooksId}";`);
        return source;
      }
    },
  }],
});
after(() => vite.close());
const { events } = await vite.ssrLoadModule(runtimeId);
const { setPhase } = await vite.ssrLoadModule(hooksId);
const { EarthMap } = await vite.ssrLoadModule("/features/earth/earth-map.tsx");
const { EarthSharingPanelContent, EarthSharingToggle } = await vite.ssrLoadModule("/features/earth/earth-sharing-panel.tsx");
const { EarthFriendSharingControls } = await vite.ssrLoadModule("/features/earth/earth-friend-sharing.tsx");
const { EarthMeetCard } = await vite.ssrLoadModule("/features/earth/earth-meet-card.tsx");
function nodes(tree) {
  const result = [];
  const visit = node => {
    if (!isValidElement(node)) return;
    if (node.type === EarthSharingToggle) { visit(EarthSharingToggle(node.props)); return; }
    if (node.type === EarthFriendSharingControls) { visit(EarthFriendSharingControls(node.props)); return; }
    result.push(node); Children.forEach(node.props.children, visit);
  };
  visit(tree); return result;
}
const cueIds = () => events.map(event => event.cueId);
const button = (all, label) => all.find(node => node.type === "button" && (node.props["aria-label"] === label || node.props["aria-labelledby"] === label || node.props.children === label));

test("map controls opt into delegated UI audio while a repeated lighting choice is silent", () => {
  events.length = 0;
  const mapProps = { position: null, active: true, visible: true, focusRequest: 0, isOnline: true,
    onLocate() {}, locating: false, locationActive: false, locationDetails: null, infoOpen: true, onInfoOpenChange() {} };
  setPhase("ready");
  const tree = EarthMap(mapProps), all = nodes(tree);
  for (const label of ["Показать всю Землю", "Повернуть карту севером вверх", "Найти меня", "Выключить погоду", "earth-buildings-label"]) {
    assert.equal(button(all, label).props["data-audio-cue"], "ui.click", label);
  }
  for (const removed of ["Приблизить карту", "Отдалить карту", "earth-weather-label"]) assert.equal(button(all, removed), undefined);
  assert.equal(all.filter(node => node.type === "a" && node.props.href === "https://api.met.no/").length, 1);
  assert.equal(button(all, "О карте и её настройках").props["data-audio-cue"], "ui.close");
  assert.equal(button(all, "Закрыть настройки карты").props["data-audio-cue"], "ui.close");
  assert.deepEqual(cueIds(), [], "rendering never emits a sound");
  button(all, "Авто").props.onClick(); assert.deepEqual(cueIds(), []);
  const day = button(all, "День");
  assert.equal(day.props["data-audio-cue"], undefined, "the explicit tab handler has no delegated duplicate");
  day.props.onClick(); assert.deepEqual(cueIds(), ["ui.tab"]);
  const dialog = all.find(node => node.props.id === "earth-info-panel");
  dialog.props.onKeyDown({ key: "Escape", stopPropagation() {} });
  assert.deepEqual(cueIds(), ["ui.tab", "ui.close"]);
  setPhase("loading");
  const loadingButtons = nodes(EarthMap(mapProps)).filter(node => node.type === "button" && node.props["data-audio-cue"]);
  for (const node of loadingButtons.filter(node => !node.props["data-earth-diagnostics"])) assert.equal(node.props.disabled, true);
  assert.notEqual(loadingButtons.find(node => node.props["data-earth-diagnostics"])?.props.disabled, true,
    "DEV diagnostics remain usable while the map cannot load");
  setPhase("ready");
});

function sharingView(extra = {}) {
  const changes = [];
  const settings = { mode: "SHARING", revision: 1, precision: "APPROXIMATE", recipientCircleIds: ["one"], frozenCircleIds: [] };
  const tree = EarthSharingPanelContent({ sharing: { settings, saving: false, pendingGhost: false, publishing: false, refresh() {}, ...extra.sharing },
    people: { people: [{ circleId: "one", user: { displayName: "Лена" } }] }, peopleLoading: false, online: true,
    onShare() {}, onGhost() {}, onOff() {}, onSetFrozen() {}, onRevokeRecipient() {},
    draft: { revision: 1, precision: "APPROXIMATE", durationMinutes: 60 }, onPrecisionChange: value => changes.push(["precision", value]),
    onDurationChange: value => changes.push(["duration", value]), query: "", onQueryChange() {}, ...extra });
  return { changes, all: nodes(tree) };
}

test("sharing switches use one delegated click; radio/select sound only for an enabled change", () => {
  events.length = 0;
  const view = sharingView();
  const switches = view.all.filter(node => node.props.role === "switch");
  assert.ok(switches.length > 1);
  assert.ok(switches.every(node => node.props["data-audio-cue"] === "ui.click"));
  switches[0].props.onClick(); assert.deepEqual(cueIds(), [], "switch handlers do not duplicate delegated clicks");
  const approximate = view.all.find(node => node.type === "input" && node.props.value === "APPROXIMATE");
  const precise = view.all.find(node => node.type === "input" && node.props.value === "PRECISE");
  const duration = view.all.find(node => node.type === "select");
  approximate.props.onChange(); duration.props.onChange({ target: { value: "60" } });
  assert.deepEqual(view.changes, []); assert.deepEqual(cueIds(), []);
  precise.props.onChange(); duration.props.onChange({ target: { value: "forever" } });
  assert.deepEqual(view.changes, [["precision", "PRECISE"], ["duration", null]]);
  assert.deepEqual(cueIds(), ["ui.click", "ui.click"]);
  for (const extra of [{ online: false }, { working: true }, { sharing: { settings: { mode: "GHOST", recipientCircleIds: ["one"] } } }]) {
    const disabled = sharingView(extra), count = events.length;
    disabled.all.find(node => node.type === "input" && node.props.value === "PRECISE").props.onChange();
    disabled.all.find(node => node.type === "select").props.onChange({ target: { value: "480" } });
    assert.deepEqual(disabled.changes, []); assert.equal(events.length, count);
  }
});

test("native disclosures sound once per explicit open/close click and never on mount or toggle notifications", () => {
  events.length = 0;
  for (const summary of sharingView().all.filter(node => node.type === "summary")) {
    assert.equal(summary.props["data-audio-cue"], undefined);
    summary.props.onClick({ currentTarget: { closest: () => ({ open: false }) } });
    summary.props.onClick({ currentTarget: { closest: () => ({ open: true }) } });
    summary.props.onClick({ defaultPrevented: true, currentTarget: { closest() { throw new Error("cancelled disclosure"); } } });
  }
  assert.deepEqual(cueIds(), ["ui.open", "ui.close", "ui.open", "ui.close"]);
});

test("external walking audio follows the live route guard, including middle clicks, without a delegated duplicate", t => {
  events.length = 0;
  const wall = Date.parse("2026-10-20T12:00:00Z"), mono = 1000;
  let now = wall, clock = mono;
  t.mock.method(Date, "now", () => now); t.mock.method(performance, "now", () => clock);
  const person = { circleId: "one", user: { displayName: "Лена" }, latitude: 55.76, longitude: 37.63,
    accuracyMeters: 20, precision: "PRECISE", updatedAt: new Date(wall).toISOString(),
    expiresAt: new Date(wall + 3_600_000).toISOString(), expiresAtMonotonic: mono + 3_600_000 };
  const tree = EarthMeetCard({ person, position: null, now: wall, monotonicNow: mono, locating: true, onLocate() {}, onShowBoth() {}, onClose() {} });
  const all = nodes(tree), anchor = all.find(node => node.type === "a");
  assert.equal(anchor.props["data-audio-cue"], undefined);
  assert.equal(button(all, "Закрыть встречу").props["data-audio-cue"], "ui.close");
  assert.ok(all.filter(node => node.type === "button").every(node => node.props["data-audio-cue"]));
  assert.deepEqual(cueIds(), []);
  const event = (extra = {}) => ({ prevented: false, preventDefault() { this.prevented = true; }, ...extra });
  const fresh = event(); anchor.props.onClick(fresh); assert.equal(fresh.prevented, false);
  anchor.props.onAuxClick(event({ button: 1 }));
  assert.deepEqual(cueIds(), ["ui.open", "ui.open"]);
  now = wall + 300_001;
  const stale = event(); anchor.props.onClick(stale); assert.equal(stale.prevented, true);
  const middle = event({ button: 1 }); anchor.props.onAuxClick(middle); assert.equal(middle.prevented, true);
  now = wall; clock = mono + 3_600_000;
  const expired = event(); anchor.props.onClick(expired); assert.equal(expired.prevented, true);
  anchor.props.onAuxClick(event({ button: 2 })); anchor.props.onClick(event({ defaultPrevented: true }));
  assert.deepEqual(cueIds(), ["ui.open", "ui.open"], "rejected routes never produce success feedback");
});

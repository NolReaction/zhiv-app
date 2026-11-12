import assert from "node:assert/strict";
import test, { after, afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, cloneElement } from "react";
import { createServer } from "vite";

// Component-tree integration, not a DOM/layout/browser substitute. The actual
// feature components, hook and domain execute; Radix shells and the decorative
// Canvas have adapters. Renderer/lifecycle tests cover the Canvas separately.
const root = fileURLToPath(new URL("..", import.meta.url));
const hookId = "virtual:boat-map-hooks", shellId = "virtual:boat-map-shell", canvasId = "virtual:boat-map-canvas", audioId = "virtual:boat-map-audio";
const vite = await createServer({ configFile: false, appType: "custom", root, cacheDir: `/tmp/boat-map-integration-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "boat-map-component-integration", enforce: "pre",
    resolveId(id) { if ([hookId, shellId, canvasId, audioId].includes(id)) return `\0${id}`; },
    load(id) {
      if (id === `\0${audioId}`) return `export function useFishingAudio() {}`;
      if (id === `\0${canvasId}`) return `import { createElement } from "react";
        export function FishingSceneCanvas(props) { return createElement("canvas", { "data-fishing-scene": props.frame.stage, frame: props.frame }); }
        FishingSceneCanvas.__qaBoatComponent = true;`;
      if (id === `\0${shellId}`) return `
        const shell = kind => Object.assign(function Shell() {}, { __qaRadix: kind });
        export const Dialog = { Root: shell("root"), Portal: shell("portal"), Overlay: shell("overlay"), Content: shell("content"), Title: shell("title"), Description: shell("description") };
        export const AlertDialog = { Root: shell("alert-root"), Portal: shell("portal"), Overlay: shell("overlay"), Content: shell("alert-content"), Title: shell("title"), Description: shell("description"), Cancel: shell("cancel"), Action: shell("action") };`;
      if (id === `\0${hookId}`) return `
        let instances = new Map(), current, cursor = 0, effects = [], dirty = false, id = 0, visited = new Set();
        export function begin() { dirty = false; visited = new Set(); }
        export function invoke(key, callback) {
          const parent = current, previousCursor = cursor;
          current = instances.get(key); if (!current) { current = { slots: [], key }; instances.set(key, current); }
          visited.add(key); cursor = 0;
          try { return callback(); } finally { current = parent; cursor = previousCursor; }
        }
        export function finish() {
          for (const [key, instance] of instances) if (!visited.has(key)) {
            for (const slot of instance.slots) slot?.cleanup?.(); instances.delete(key);
          }
          const pending = effects; effects = [];
          for (const effect of pending) if (instances.get(effect.instance.key) === effect.instance) effect.callback();
        }
        export function changed() { return dirty; }
        export function unmount() { for (const instance of instances.values()) for (const slot of instance.slots) slot?.cleanup?.(); instances.clear(); effects = []; dirty = false; }
        export function useRef(initial) { return current.slots[cursor++] ??= { current: initial }; }
        export function useState(initial) {
          const instance = current, index = cursor++; instance.slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
          return [instance.slots[index].value, next => { const value = typeof next === "function" ? next(instance.slots[index].value) : next;
            if (!Object.is(value, instance.slots[index].value)) { instance.slots[index].value = value; dirty = true; } }];
        }
        const equal = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
        export function useEffect(callback, dependencies) {
          const instance = current, index = cursor++, previous = instance.slots[index];
          if (!previous || !equal(dependencies, previous.dependencies)) {
            const slot = { dependencies, cleanup: previous?.cleanup }; instance.slots[index] = slot;
            effects.push({ instance, callback: () => { slot.cleanup?.(); slot.cleanup = callback(); } });
          }
        }
        export const useLayoutEffect = useEffect;
        export function useMemo(callback, dependencies) {
          const index = cursor++, previous = current.slots[index];
          if (!previous || !equal(dependencies, previous.dependencies)) current.slots[index] = { dependencies, value: callback() };
          return current.slots[index].value;
        }
        export const useCallback = (callback, dependencies) => useMemo(() => callback, dependencies);
        export function useId() { return useMemo(() => "boat-map-test-" + (++id), []); }
        export function inspectReel() {
          for (const instance of instances.values()) for (const slot of instance.slots)
            if (slot?.current?.reel && Array.isArray(slot.current.inputs)) return structuredClone(slot.current.reel);
          return null;
        }
      `;
    },
    transform(source, id) {
      if (!id.includes("/features/economy/ui/boat/") || !/\.(?:tsx|ts)$/.test(id)) return;
      let result = source.replaceAll('from "react";', `from "${hookId}";`).replaceAll('from "radix-ui";', `from "${shellId}";`)
        .replace('from "./scene/fishing-scene-canvas";', `from "${canvasId}";`)
        .replace('from "./use-fishing-audio";', `from "${audioId}";`);
      const components = [...source.matchAll(/^(?:export\s+)?function\s+([A-Z]\w*)\s*\(/gm)].map(match => match[1]);
      result += components.map(name => `\n${name}.__qaBoatComponent = true;`).join("");
      return result;
    },
  }] });
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hookId);
const { PlayableBoatFishingDialog } = await vite.ssrLoadModule("/features/economy/ui/boat/world-boat-fishing-dialog.tsx");
const { economyCatalog, economyCommandSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyShipSchema } = await vite.ssrLoadModule("/features/economy/domain/ship-model.ts");
const { newEconomyState, applyEconomyCommand, economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { publicBoatState } = await vite.ssrLoadModule("/features/economy/domain/boat-fishing.ts");
const { initialBoatReel, replayBoatReel, stepBoatReel } = await vite.ssrLoadModule("/features/economy/domain/boat-reel.ts");
const { boatCastAim } = await vite.ssrLoadModule("/features/economy/domain/boat-cast-aim.ts");
const { boatReelCheckpointKey, changeBoatReelInput, writeBoatReelCheckpoint } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-reel-checkpoint.ts");

const at = Date.parse("2026-11-03T10:00:00Z");
const coachKey = "zhiv.boat-controls.v1.0000-0000-0000";
const globalNames = ["window", "document", "requestAnimationFrame", "cancelAnimationFrame"];
let clock, nextFrame, frames, storage, savedGlobals;
class TrackedEvents extends EventTarget {
  listeners = new Map();
  addEventListener(type, callback, options) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); super.addEventListener(type, callback, options); }
  removeEventListener(type, callback, options) { this.listeners.get(type)?.delete(callback); super.removeEventListener(type, callback, options); }
  count() { return [...this.listeners.values()].reduce((sum, values) => sum + values.size, 0); }
}
beforeEach(t => {
  clock = 100; nextFrame = 0; frames = new Map(); storage = new Map();
  savedGlobals = globalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const memory = values => ({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) });
  const localStorage = memory(new Map([[coachKey, "seen"]]));
  Object.assign(globalThis, { window: Object.assign(new TrackedEvents(), { sessionStorage: memory(storage), localStorage }), document: Object.assign(new TrackedEvents(), { hidden: false, activeElement: null }),
    requestAnimationFrame: callback => { const id = ++nextFrame; frames.set(id, callback); return id; }, cancelAnimationFrame: id => frames.delete(id) });
  t.mock.method(performance, "now", () => clock);
});
afterEach(() => {
  hooks.unmount();
  for (const [name, descriptor] of savedGlobals) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
});

function featureTree(element, path, hosts, context = {}) {
  if (element == null || typeof element === "boolean") return [];
  if (typeof element === "string" || typeof element === "number") return [String(element)];
  if (Array.isArray(element)) return element.flatMap((child, index) => featureTree(child, `${path}.${index}`, hosts, context));
  const { type, props = {} } = element;
  const childPath = `${path}/${typeof type === "string" ? type : type?.name ?? "fragment"}:${element.key ?? ""}`;
  const shell = type?.__qaRadix;
  if (shell === "root" || shell === "alert-root") return props.open ? featureTree(props.children, childPath, hosts, { ...context, [shell]: props.onOpenChange }) : [];
  if (shell === "portal") return featureTree(props.children, childPath, hosts, context);
  if (shell === "cancel" || shell === "action") {
    const child = props.children, previous = child.props.onClick;
    return featureTree(cloneElement(child, { onClick: event => { previous?.(event); if (!event.defaultPrevented) context["alert-root"]?.(false); } }), childPath, hosts, context);
  }
  if (shell) return featureTree(createElement(shell === "title" ? "h2" : shell === "description" ? "p" : "div", { ...props,
    ...(shell === "content" || shell === "alert-content" ? { role: shell === "content" ? "dialog" : "alertdialog" } : {}) }), childPath, hosts, context);
  if (typeof type === "symbol") return featureTree(props.children, childPath, hosts, context);
  if (typeof type === "function") {
    if (!type.__qaBoatComponent) return [{ tag: "presentation", props, children: [] }];
    const result = hooks.invoke(childPath, () => type(props));
    return featureTree(result, childPath, hosts, context);
  }
  if (typeof type !== "string") return [{ tag: "icon", props: {}, children: [] }];
  let host = hosts.get(childPath);
  if (!host) { host = Object.assign(new TrackedEvents(), { tag: type, props, children: [], focus() { document.activeElement = this; }, scrollTo() {}, closest(selector) {
      return selector === "[data-boat-dialog]" ? [...hosts.values()].find(host => host.props["data-boat-dialog"]) : null;
    }, setPointerCapture(id) { this.captured = id; } }); hosts.set(childPath, host); }
  host.props = props; host.children = featureTree(props.children, childPath, hosts, context);
  if (props.ref) { if (typeof props.ref === "function") props.ref(host); else props.ref.current = host; }
  return [host];
}
const flatten = tree => tree.flatMap(node => typeof node === "string" ? [] : [node, ...flatten(node.children)]);
const text = node => typeof node === "string" ? node : node.children.map(text).join("");
const event = (node, extra = {}) => ({ currentTarget: node, target: node, nativeEvent: { isComposing: false },
  button: 0, isPrimary: true, pointerId: 7, key: " ", repeat: false, altKey: false, ctrlKey: false, metaKey: false,
  defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra });

function fixture({ outbound = false, dev = false } = {}) {
  let state = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 4, workshopLevel: 3 });
  state.wallet.coins = 100000; state.inventory = { planks: 20, rope: 20 }; state.buildings.warehouse = 5; state.boat.level = 1;
  let time = at, revision = 1, open = true, busy = false, tree = [], hosts = new Map();
  const pending = [], commands = [];
  let localBoatSettlement, lastBoatLanding;
  const apply = command => { const next = structuredClone(state); applyEconomyCommand(next, command, time, () => crypto.randomUUID(), {}, maximum => 37 % maximum); state = next; revision++; commands.push(command); };
  const command = (action, targetId, input) => economyCommandSchema.parse({ requestId: crypto.randomUUID(), ownerPublicId: "0000-0000-0000", expectedRevision: revision, action, targetId, quantity: 1, totalPrice: 0, ...(input && "castHeldMs" in input ? { castHeldMs: input.castHeldMs } : input ? { reel: input } : {}) });
  apply(command("depart_boat", economyCatalog.boat.routeId));
  if (outbound) {
    // A voyage saved before the fuel update keeps its original schedule.
    const voyage = state.boat.voyage;
    voyage.outboundSeconds = 300; voyage.inboundSeconds = 300;
    voyage.arrivesAt = new Date(time + 300_000).toISOString();
    voyage.fishingUntil = new Date(Date.parse(voyage.fishingUntil) + 300_000).toISOString();
  }
  const view = () => ({ ...state, ownerPublicId: "0000-0000-0000", revision, serverTime: new Date(time).toISOString(), catalog: economyCatalog,
    boat: publicBoatState(state.boat), ship: economyShipSchema.parse(state.ship), storage: economyStorage(state) });
  const render = () => {
    for (let iteration = 0; iteration < 30; iteration++) {
      hooks.begin();
      const economy = { snapshot: view(), now: time, snapshotConfirmed: true, busy, uncertain: false, retryAt: 0, error: null, devAvailable: dev, localBoatSettlement, lastBoatLanding,
        pendingBoatCastId: pending.find(request => request.action === "submit_boat_cast")?.reel?.challengeId,
        act(action, targetId, quantity, totalPrice, fishSelection, unused, reel) { if (busy) return false; busy = true; pending.push(command(action, targetId, reel)); return true; }, refresh() {}, retry() {} };
      tree = featureTree(open ? createElement(PlayableBoatFishingDialog, { economy, onClose() { open = false; } }) : null, "root", hosts);
      hooks.finish(); if (!hooks.changed()) return tree;
    }
    assert.fail("Boat feature effects did not settle");
  };
  const find = predicate => flatten(tree).find(predicate);
  const byAction = action => find(node => node.props["data-fishing-action"] === action);
  const click = node => { assert(node, "Expected an available control"); assert.equal(Boolean(node.props.disabled), false); node.props.onClick?.(event(node)); render(); };
  const frame = (elapsed = 50) => { clock += elapsed; time += elapsed; for (const [id, callback] of [...frames]) if (frames.delete(id)) callback(clock); render(); };
  const flush = ({ local = true } = {}) => {
    for (const request of pending.splice(0)) {
      apply(request);
      if (local && request.action === "submit_boat_cast") lastBoatLanding = { challengeId: request.reel.challengeId, revision };
      if (request.action === "claim_boat" || request.action === "sell_boat_catch") {
        localBoatSettlement = { voyageId: request.targetId, requestId: request.requestId, revision,
          ...(request.action === "sell_boat_catch" ? { saleCoins: request.totalPrice } : {}) };
      }
    }
    busy = false; render();
  };
  render();
  return { render, find, byAction, click, frame, flush, view, pending, commands,
    get state() { return state; }, get tree() { return tree; },
    advanceTo(next) { const elapsed = next - time; assert(elapsed >= 0); time = next; clock += elapsed; render(); },
    close() { open = false; render(); }, reopen() { open = true; render(); },
    cast() {
      const button = byAction("cast"); assert(button);
      button.props.onPointerDown(event(button)); render(); frame(350);
      button.props.onPointerUp(event(button)); render(); flush(); frame(0);
    },
    play() { const biteAt = Date.parse(state.boat.voyage.challenge.biteAt ?? state.boat.voyage.challenge.startedAt); if (time < biteAt) frame(biteAt - time); if (byAction("line")) {
        const water = byAction("line"); water.props.onPointerDown(event(water)); water.props.onPointerUp(event(water)); render();
      } frame(0); assert(byAction("hold")); },
    hold(value, input = "keyboard") { const button = byAction("hold"); assert(button); if (input === "pointer") button.props[value ? "onPointerDown" : "onPointerUp"](event(button));
      else button.props[value ? "onKeyDown" : "onKeyUp"](event(button)); render(); },
    playToResult() {
      for (let i = 0; i <= state.boat.voyage.challenge.maxTicks && hooks.inspectReel()?.status === "active"; i++) {
        const reel = hooks.inspectReel(); this.hold(reel.fish > reel.bar + reel.velocity * 4); frame(50);
      }
      assert.notEqual(hooks.inspectReel()?.status, "active", "local fight reaches a terminal tick");
      return hooks.inspectReel();
    },
  };
}

test("the first river course appears once, skips without spending a cast, and can be replayed for practice", () => {
  window.localStorage.removeItem(coachKey);
  const f = fixture(), initial = structuredClone(f.state.boat.voyage);
  const course = () => f.find(node => node.props["data-boat-fishing-course"]);
  f.frame(0);
  assert.match(text(course()), /Забросьте удочку.*Подсеките при нырке.*Подведите рыбу к борту/);
  assert.equal(f.byAction("cast").props.disabled, true);
  assert.equal(window.localStorage.getItem(coachKey), "seen");
  f.click(f.byAction("course-skip"));
  f.close(); f.reopen(); f.frame(0);
  assert.equal(course(), undefined);
  assert.equal(f.find(node => node.props["data-fishing-coach"]), undefined);
  f.click(f.byAction("coach-shortcut"));
  assert(course());
  f.click(f.byAction("course-start"));
  assert.equal(course(), undefined);
  assert(f.find(node => node.props["data-fishing-coach"] === "cast"));
  assert.deepEqual(f.state.boat.voyage, initial); assert.equal(f.pending.length, 0);
  f.cast();
  assert.equal(f.state.boat.voyage.castsUsed, 1);
  // Recovering a real challenge takes precedence even on a browser with no lesson receipt.
  window.localStorage.removeItem(coachKey);
  f.close(); f.reopen(); f.frame(0);
  assert.equal(course(), undefined); assert.equal(window.localStorage.getItem(coachKey), null);
  assert.equal(f.commands.length, 2);
});

test("actual root changes from timed outbound to one separate river scene without disclosing or starting a cast", () => {
  const f = fixture({ outbound: true }), before = structuredClone(f.state.boat.voyage);
  assert.equal(f.find(node => node.props["data-boat-map-view"]), undefined);
  assert(f.find(node => node.props.role === "tablist"));
  f.advanceTo(Date.parse(before.arrivesAt));
  assert(f.find(node => node.props["data-boat-map-view"] === true));
  assert.equal(flatten(f.tree).filter(node => node.tag === "canvas").length, 1);
  assert.equal(f.find(node => node.props.role === "tablist"), undefined);
  assert.equal(f.find(node => node.props["data-boat-garage"]), undefined);
  assert(f.byAction("cast")); assert.equal(f.commands.length, 1); assert.equal(f.pending.length, 0);
  assert.deepEqual(f.state.boat.voyage, before);
  assert.equal(f.view().boat.voyage.slots, undefined);
  assert.equal(f.view().boat.voyage.catches.length, 0);
  assert.doesNotMatch(JSON.stringify(f.find(node => node.tag === "canvas").props.frame), /fishId|weightGrams|challengeSeed|slots/);
  f.cast(); assert.equal(f.state.boat.voyage.castsUsed, 1);
  assert.equal(f.find(node => node.props["data-reel-status"] === "casting").props["data-reel-tick"], 0);
  assert.equal(f.find(node => node.tag === "canvas").props.frame.stage, "casting");
  assert.equal(f.byAction("play"), undefined);
  f.frame(1200); assert.equal(f.find(node => node.tag === "canvas").props.frame.stage, "soaking");
  assert.equal(f.byAction("play"), undefined);
  f.frame(Date.parse(f.state.boat.voyage.challenge.biteAt) - Date.parse(f.view().serverTime));
  assert.equal(f.find(node => node.tag === "canvas").props.frame.stage, "bite", "the bite cue and controls arrive together");
  assert(f.byAction("hold")); f.frame(50); assert.equal(f.find(node => node.tag === "canvas").props.frame.stage, "reeling"); assert.equal(f.byAction("play"), undefined);
  assert.equal(f.find(node => node.tag === "canvas").props.frame.fishRarity, undefined, "the water scene cannot show the upcoming catch class");
  assert.equal(f.view().boat.voyage.challenge.fishId, undefined);
  assert.equal(f.view().boat.voyage.challenge.weightGrams, undefined);
  assert.equal(f.commands.filter(request => request.action === "submit_boat_cast").length, 0);
});

test("a short cast restores the same landing distance before and after receipt and stays bound to its attempt", () => {
  const f = fixture(), button = f.byAction("cast");
  button.props.onPointerDown(event(button)); f.render(); f.frame(285);
  button.props.onPointerUp(event(button)); f.render();
  f.close(); f.flush(); f.reopen(); f.frame(0);
  const scene = () => f.find(node => node.tag === "canvas").props.frame;
  const power = scene().castPower;
  assert.equal(power, 39);
  const key = "zhiv.boat-cast.v1.0000-0000-0000";
  const first = f.state.boat.voyage.challenge;
  assert.equal(JSON.parse(window.sessionStorage.getItem(key)).challenge, first.id);
  f.close(); f.reopen(); f.frame(0); assert.equal(scene().castPower, power);
  f.state.boat.voyage.challenge.id = crypto.randomUUID(); f.render(); f.frame(0);
  assert.equal(scene().castPower, 100, "another challenge cannot reuse the saved aim");
  f.advanceTo(Date.parse(first.expiresAt)); f.frame(0);
  const next = f.byAction("cast"); next.props.onPointerDown(event(next)); f.frame(350);
  next.props.onPointerUp(event(next)); f.render();
  assert.equal(f.find(node => node.props["data-cast-result"] !== undefined).props["data-cast-result"], boatCastAim(f.state.boat.voyage.id, 2, 350).quality);
  f.flush(); f.frame(0);
  assert.equal(JSON.parse(window.sessionStorage.getItem(key)).challenge, f.state.boat.voyage.challenge.id);
  assert.equal(scene().castPower, 45);
});

test("short taps and keystrokes neither wind up nor spend a cast; a fresh deliberate hold casts once", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), water = f.byAction("cast");
  const advance = elapsed => { f.frame(elapsed); t.mock.timers.tick(elapsed); f.render(); };
  const meter = () => f.find(node => node.props.role === "meter");
  assert.equal(text(water), "Удерживать для заброса");
  for (const [down, up] of [["onPointerDown", "onPointerUp"], ["onKeyDown", "onKeyUp"]]) {
    water.props[down](event(water)); advance(279);
    assert.equal(meter(), undefined); assert.equal(f.find(node => node.tag === "canvas").props.frame.aiming, false);
    water.props[up](event(water)); advance(50);
    assert.equal(meter(), undefined); assert.equal(f.pending.length, 0); assert.equal(f.state.boat.voyage.castsUsed, 0);
  }
  water.props.onPointerDown(event(water));
  water.props.onPointerCancel(event(water, { pointerId: 8, isPrimary: false })); advance(280);
  assert.equal(meter().props["data-marker"], 28); assert.equal(f.find(node => node.tag === "canvas").props.frame.aiming, true);
  assert.equal(f.find(node => node.props["data-fishing-cue"] === "cast"), undefined);
  water.props.onPointerUp(event(water)); water.props.onPointerUp(event(water)); f.render();
  assert.equal(f.pending.length, 1); assert.equal(f.pending[0].castHeldMs, 280);
  f.flush(); assert.equal(f.state.boat.voyage.castsUsed, 1);
});

test("a new deliberate cast released during landing uses the confirmed revision exactly once", async () => {
  const f = fixture(); f.cast(); f.play(); assert.equal(f.playToResult().status, "caught");
  const water = f.byAction("cast"); assert(water); assert.equal(water.props.disabled, false);
  water.props.onPointerUp(event(water)); f.render(); // Lift the finger originally used to reel.
  assert.equal(f.pending.length, 1);
  water.props.onPointerDown(event(water)); f.frame(370); water.props.onPointerUp(event(water)); f.render();
  assert.equal(f.pending.length, 1); assert.match(text(f.byAction("cast")), /Замах готов/);
  f.flush(); await Promise.resolve(); f.render(); await Promise.resolve();
  assert.deepEqual(f.pending.map(row => row.action), ["begin_boat_cast"]); assert.equal(f.pending[0].castHeldMs, 370);
  f.flush(); assert.equal(f.state.boat.voyage.castsUsed, 2); assert.equal(f.state.boat.voyage.catches.length, 1);
});

test("a fresh cast held across confirmation charges continuously but spends nothing until release", () => {
  const f = fixture(); f.cast(); f.play(); f.playToResult();
  const water = f.byAction("cast"); water.props.onPointerDown(event(water)); f.frame(150);
  f.flush(); f.frame(190); assert.equal(f.pending.length, 0);
  assert.equal(f.byAction("cast"), water);
  water.props.onPointerUp(event(water)); f.render();
  assert.deepEqual(f.pending.map(row => row.action), ["begin_boat_cast"]); assert.equal(f.pending[0].castHeldMs, 340);
});

for (const reason of ["close", "blur", "album", "foreign receipt"]) test(`a prepared cast is discarded on ${reason}`, async () => {
  const f = fixture(); f.cast(); f.play(); f.playToResult();
  const water = f.byAction("cast"); water.props.onPointerDown(event(water)); f.frame(350); water.props.onPointerUp(event(water)); f.render();
  assert.match(text(f.byAction("cast")), /Замах готов/);
  if (reason === "close") f.close();
  if (reason === "blur") window.dispatchEvent(new Event("blur"));
  if (reason === "album") f.click(f.byAction("album"));
  f.flush({ local: reason !== "foreign receipt" }); await Promise.resolve(); f.render();
  assert.deepEqual(f.pending, []); assert.equal(f.state.boat.voyage.castsUsed, 1);
});

test("the last hold space permits another wind-up after a miss but not after a local catch", () => {
  const caught = fixture(); caught.state.boat.voyage.maxCatches = 1;
  caught.cast(); caught.play(); caught.playToResult(); assert.equal(caught.byAction("cast"), undefined);
  caught.close(); caught.flush();
  const missed = fixture(); missed.state.boat.voyage.maxCatches = 1; missed.cast();
  const bite = Date.parse(missed.state.boat.voyage.challenge.biteAt);
  missed.advanceTo(bite + 4000); missed.frame(0);
  assert.equal(missed.pending[0]?.reel.missedBite, true);
  assert.equal(missed.byAction("cast")?.props.disabled, false);
});

test("cancelled charges keep the budget and a missed bite settles once with no catch", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const button = f.byAction("cast"); button.props.onPointerDown(event(button)); f.frame(700); t.mock.timers.tick(700); f.render();
  assert.equal(f.pending.length, 0); assert.equal(f.find(node => node.props.role === "meter").props["data-marker"], 70);
  button.props.onPointerCancel(event(button)); f.render();
  button.props.onPointerUp(event(button)); f.render();
  assert.equal(f.pending.length, 0); assert.equal(f.state.boat.voyage.castsUsed, 0);
  button.props.onKeyDown(event(button, { key: " " })); f.frame(1000); t.mock.timers.tick(1000); f.render();
  assert.equal(f.find(node => node.props.role === "meter").props["data-marker"], 100);
  button.props.onKeyUp(event(button, { key: " " })); f.render(); f.flush(); f.frame(0);
  const voyage = f.state.boat.voyage, biteAt = Date.parse(voyage.challenge.biteAt);
  f.frame(biteAt - Date.parse(f.view().serverTime)); assert(f.byAction("line")); assert.equal(f.byAction("hold"), undefined);
  f.frame(3199); assert.equal(f.pending.length, 0); assert.equal(hooks.inspectReel().tick, 0);
  f.frame(1); assert.equal(f.pending.length, 1); assert.equal(f.pending[0].reel.missedBite, true);
  f.flush(); assert.equal(f.state.boat.voyage.challenge, undefined); assert.deepEqual(f.state.boat.voyage.catches, []);
  assert.equal(f.state.boat.voyage.castsUsed, 1); assert(f.byAction("cast"));
});

test("a keyboard cast passes focus through the dialog trap to the water for the strike", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), cast = f.byAction("cast");
  cast.focus(); cast.props.onKeyDown(event(cast)); f.frame(385); t.mock.timers.tick(385); f.render();
  cast.props.onKeyUp(event(cast)); f.render();
  const expectedQuality = boatCastAim(f.state.boat.voyage.id, 1, 385).quality;
  const release = () => f.find(node => node.props["data-cast-result"] !== undefined);
  assert.equal(release().props["data-cast-result"], expectedQuality);
  f.find(node => node.props["data-boat-dialog"]).focus();
  f.flush(); f.frame(0);
  assert.equal(release().props["data-cast-result"], expectedQuality);
  assert.equal(document.activeElement, f.byAction("line"));
  f.frame(3199); t.mock.timers.tick(3199); f.render();
  assert.equal(release().props["data-cast-result"], expectedQuality, "the exact release stays readable after the cast lands");
  f.frame(1); t.mock.timers.tick(1); f.render(); assert.equal(release(), undefined);
  f.frame(Date.parse(f.state.boat.voyage.challenge.biteAt) - Date.parse(f.view().serverTime));
  assert.equal(release(), undefined, "no accuracy toast covers the bite");
  document.activeElement.props.onKeyDown(event(document.activeElement)); f.render();
  assert.equal(document.activeElement, f.byAction("hold"));
  assert.equal(f.byAction("pause"), undefined); assert.equal(f.byAction("play"), undefined);
});

test("a premature hold cannot hook across the bite, and only optional hints teach when to strike", () => {
  const f = fixture();
  assert.equal(f.find(node => node.props["data-fishing-coach"]), undefined);
  f.click(f.byAction("coach")); f.click(f.byAction("course-start"));
  assert.match(text(f.find(node => node.props["data-fishing-coach"] === "cast")), /зелёную зону/);
  f.click(f.byAction("coach")); f.click(f.byAction("course-skip")); f.cast();
  const water = f.byAction("line");
  assert(water); assert.equal(text(water), "");
  water.props.onPointerDown(event(water)); f.render();
  f.frame(Date.parse(f.state.boat.voyage.challenge.biteAt) - Date.parse(f.view().serverTime));
  assert.equal(f.byAction("line"), water); assert.equal(f.byAction("hold"), undefined);
  assert.equal(f.find(node => node.props["data-fishing-coach"]), undefined);
  assert.equal(f.find(node => node.tag === "canvas").props.frame.stage, "bite");
  water.props.onPointerUp(event(water)); f.render();
  assert.equal(f.byAction("hold"), undefined);
  water.props.onKeyDown(event(water)); f.render();
  assert.equal(f.byAction("hold"), water); assert.equal(water.props["aria-pressed"], true);
  assert.match(text(water), /Ослабить снасть.*Отпустите/);
  water.props.onKeyUp(event(water)); f.render(); assert.equal(water.props["aria-pressed"], false);
  assert.match(text(water), /Тянуть снасть.*Удерживайте/);
});

test("late viewers cannot settle another tab's hook implicitly, while a legacy attempt still reels automatically", () => {
  const f = fixture();
  f.cast(); const first = f.state.boat.voyage.challenge;
  f.close(); storage.clear(); // A second tab has its own session storage.
  f.advanceTo(Date.parse(first.biteAt) + 4000); f.reopen(); f.frame(0);
  assert.equal(f.byAction("hook"), undefined); assert.equal(f.byAction("hold"), undefined);
  assert(f.byAction("skip-bite")); f.frame(1500); assert.deepEqual(f.pending, []);
  f.click(f.byAction("skip-bite")); assert.equal(f.pending.length, 1); assert.equal(f.pending[0].reel.missedBite, true);
  f.flush(); assert.equal(f.state.boat.voyage.castsUsed, 1); assert(f.byAction("cast"));

  f.cast(); f.close();
  const legacy = f.state.boat.voyage.challenge;
  legacy.rulesVersion = 5;
  f.advanceTo(Date.parse(legacy.biteAt) + 200); f.reopen(); f.frame(0);
  assert.equal(f.byAction("skip-bite"), undefined); assert.equal(f.byAction("hook"), undefined);
  assert(f.byAction("hold")); assert.equal(hooks.inspectReel().tick, 4); assert.deepEqual(f.pending, []);
});

test("overlays release the water, keep the fight visible and allow the fish to escape", () => {
  const f = fixture({ dev: true }); f.cast(); f.play();
  const initialInventory = structuredClone(f.state.inventory);
  const scene = () => f.find(node => node.tag === "canvas").props.frame;
  const waterInput = () => f.find(node => node.props["data-boat-map"]).props["data-water-input"];
  const catchButton = () => f.find(node => node.tag === "button" && text(node).startsWith("Улов ·"));
  const devButton = () => f.find(node => node.tag === "button" && text(node) === "DEV");
  const overlays = [
    [catchButton, () => f.find(node => node.props["aria-label"] === "Закрыть улов")],
    [devButton, devButton],
    [() => f.byAction("return"), () => f.find(node => node.tag === "button" && text(node) === "Остаться")],
    [() => f.byAction("album"), () => f.find(node => node.props["aria-label"] === "Закрыть альбом рыбака")],
  ];
  for (const [open, close] of overlays) {
    f.hold(true, "pointer"); f.frame(50); const tick = hooks.inspectReel().tick;
    f.click(open());
    assert.equal(waterInput(), undefined, "the overlay permits normal text interaction");
    assert(f.byAction("hold").props.disabled); assert.equal(f.byAction("hold").props["aria-pressed"], false);
    f.frame(200);
    assert.equal(hooks.inspectReel().tick, tick + 4);
    assert.equal(scene().stage, "reeling"); assert.equal(scene().reel.bar, hooks.inspectReel().bar);
    assert.equal(scene().reel.fish, hooks.inspectReel().fish);
    f.click(close()); assert.equal(f.byAction("hold").props.disabled, false);
    assert.equal(waterInput(), true, "holding the water also protects the reel meter from selection");
    assert.equal(f.byAction("play"), undefined);
  }
  f.click(f.byAction("album"));
  for (let tick = 0; tick <= f.state.boat.voyage.challenge.maxTicks && hooks.inspectReel().status === "active"; tick += 10) f.frame(500);
  assert.equal(hooks.inspectReel().status, "escaped"); assert.equal(scene().stage, "escaped");
  assert.equal(f.pending.length, 1); assert.equal(f.pending[0].action, "submit_boat_cast");
  f.flush(); assert.equal(f.state.boat.voyage.catches.length, 0); assert.equal(f.state.boat.voyage.castsUsed, 1);
  assert.equal(f.commands.filter(request => request.action === "return_boat").length, 0);
  assert.deepEqual(f.state.inventory, initialInventory);
});

test("closing the river and hiding the tab release input but the same fish keeps moving", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); f.cast(); f.play(); f.hold(true); f.frame(100);
  const voyageId = f.state.boat.voyage.id, challenge = f.state.boat.voyage.challenge, tick = hooks.inspectReel().tick;
  const listenerCount = window.count() + document.count();
  f.click(f.find(node => node.tag === "button" && text(node) === "К поляне"));
  assert(f.find(node => node.props["data-leaving"]));
  f.frame(250); t.mock.timers.tick(260); f.render();
  assert.equal(frames.size, 0); assert.equal(window.count() + document.count(), 0);
  const key = boatReelCheckpointKey("0000-0000-0000", voyageId, challenge.id);
  assert.equal(JSON.parse(storage.get(key)).endTick, tick + 5);
  f.frame(200); f.reopen(); f.frame(0);
  assert.equal(f.state.boat.voyage.id, voyageId); assert.equal(f.state.boat.voyage.challenge.id, challenge.id);
  assert.equal(hooks.inspectReel().tick, tick + 9);
  assert.equal(f.byAction("hold").props["aria-pressed"], false);
  assert.equal(frames.size, 1); assert.equal(window.count() + document.count(), listenerCount);
  f.hold(true); f.frame(50); const beforeHidden = hooks.inspectReel().tick;
  document.hidden = true; document.dispatchEvent(new Event("visibilitychange")); f.render();
  f.advanceTo(Date.parse(f.view().serverTime) + 500);
  document.hidden = false; document.dispatchEvent(new Event("visibilitychange")); f.frame(0);
  assert.equal(hooks.inspectReel().tick, beforeHidden + 10);
  assert.equal(f.byAction("hold").props["aria-pressed"], false);
  f.hold(true); assert.equal(f.byAction("hold").props["aria-pressed"], true);
  assert.equal(f.state.boat.voyage.catches.length, 0); assert.equal(f.commands.filter(request => request.action === "begin_boat_cast").length, 1);
  f.close(); assert.equal(frames.size, 0); assert.equal(window.count() + document.count(), 0);
});

test("the last hooked attempt finishes once after reopening beyond its expiry before showing the return screen", () => {
  const f = fixture(); f.state.boat.voyage.maxCasts = 1; f.state.boat.voyage.slots = f.state.boat.voyage.slots.slice(0, 1); f.render(); f.cast(); f.play();
  f.hold(true); f.frame(150); f.hold(false); f.frame(100);
  const challenge = structuredClone(f.state.boat.voyage.challenge), started = hooks.inspectReel();
  const key = boatReelCheckpointKey("0000-0000-0000", f.state.boat.voyage.id, challenge.id);
  f.close();
  const saved = JSON.parse(storage.get(key)), expectedInputs = structuredClone(saved.inputs);
  changeBoatReelInput(expectedInputs, saved.endTick, false);
  let expected = started;
  while (expected.status === "active") expected = stepBoatReel(challenge, expected, false);
  assert.equal(expected.status, "escaped");
  f.advanceTo(Date.parse(challenge.expiresAt) + 180_000); f.reopen(); f.frame(0);
  assert.equal(f.pending.length, 1); assert.equal(f.pending[0].action, "submit_boat_cast");
  const trace = f.pending[0].reel;
  assert.equal(trace.deferred, true); assert.equal(trace.endTick, expected.tick);
  assert.deepEqual(trace.inputs, expectedInputs.filter(input => input.tick < expected.tick));
  assert.deepEqual(replayBoatReel(challenge, trace.inputs, trace.endTick), expected);
  assert.equal(f.byAction("cast"), undefined);
  assert.equal(f.find(node => node.props["aria-label"] === "Завершить рыбалку и вернуться домой"), undefined);
  f.frame(100); f.render(); assert.equal(f.pending.length, 1);
  f.flush(); assert.equal(f.state.boat.voyage.castsUsed, 1);
  assert.equal(f.state.boat.voyage.challenge, undefined); assert.equal(f.state.boat.voyage.catches.length, 0);
  assert(f.find(node => node.props["aria-label"] === "Завершить рыбалку и вернуться домой"));
  assert.equal(f.commands.filter(request => request.action === "submit_boat_cast").length, 1);
});

test("a finished legacy draft without a start timestamp still delivers the last catch before expiry", () => {
  const f = fixture(); f.state.boat.voyage.maxCasts = 1; f.state.boat.voyage.slots = f.state.boat.voyage.slots.slice(0, 1); f.render(); f.cast();
  const voyageId = f.state.boat.voyage.id, challenge = structuredClone(f.state.boat.voyage.challenge);
  f.close();
  let result = initialBoatReel(challenge);
  const inputs = [];
  while (result.status === "active") {
    const held = result.fish > result.bar + result.velocity * 4;
    changeBoatReelInput(inputs, result.tick, held); result = stepBoatReel(challenge, result, held);
  }
  assert.equal(result.status, "caught");
  const key = boatReelCheckpointKey("0000-0000-0000", voyageId, challenge.id);
  writeBoatReelCheckpoint(window.sessionStorage, key, challenge, result, inputs);
  assert.equal(JSON.parse(storage.get(key)).reelStartedAt, undefined);
  f.advanceTo(Date.parse(challenge.expiresAt) - 1); f.reopen(); f.frame(0);
  assert.equal(f.pending.length, 1); assert.equal(f.pending[0].reel.endTick, result.tick);
  assert.deepEqual(replayBoatReel(challenge, f.pending[0].reel.inputs, result.tick), result);
  assert.equal(f.byAction("cast"), undefined);
  assert.equal(f.find(node => node.props["aria-label"] === "Завершить рыбалку и вернуться домой"), undefined);
  f.flush(); assert.equal(f.state.boat.voyage.catches.length, 1); assert.equal(f.state.boat.voyage.castsUsed, 1);
  assert.equal(f.commands.filter(request => request.action === "submit_boat_cast").length, 1);
  assert(f.find(node => node.props["aria-label"] === "Завершить рыбалку и вернуться домой"));
});

test("caught UI automatically submits one replay verified trace then credits inventory only after confirmed return and unloading", () => {
  const f = fixture(); f.cast(); f.play(); const inventory = structuredClone(f.state.inventory), challenge = structuredClone(f.state.boat.voyage.challenge);
  const result = f.playToResult(); assert.equal(result.status, "caught");
  assert.equal(f.find(node => node.tag === "canvas").props.frame.stage, "caught");
  assert.deepEqual(f.state.inventory, inventory); assert.equal(f.state.boat.voyage.catches.length, 0);
  assert.equal(f.find(node => node.props["data-confirmed-catch"]), undefined);
  assert.equal(f.byAction("submit"), undefined); f.frame(16); f.render();
  assert.equal(f.pending.length, 1); assert.equal(f.state.boat.voyage.catches.length, 0);
  assert(f.find(node => node.props["data-reel-status"] === "pending"));
  const request = f.pending[0]; assert.deepEqual(replayBoatReel(challenge, request.reel.inputs, request.reel.endTick), result);
  f.flush(); assert.equal(f.state.boat.voyage.catches.length, 1);
  assert.equal(f.find(node => node.tag === "canvas").props.frame.stage, "landed");
  assert.equal(f.find(node => node.tag === "canvas").props.frame.fishId, f.state.boat.voyage.catches[0].fishId);
  const receipt = f.find(node => node.props["data-confirmed-catch"]);
  assert.equal(receipt.props["data-confirmed-catch"], f.state.boat.voyage.catches[0].fishId);
  assert.match(text(receipt), /Улов подтверждён/); assert.deepEqual(f.state.inventory, inventory);
  assert.equal(f.commands.filter(command => command.action === "submit_boat_cast").length, 1);
  f.click(f.byAction("return")); f.click(f.byAction("confirm-return")); assert.equal(f.pending.length, 1);
  f.flush(); const returns = Date.parse(f.state.boat.voyage.returnsAt);
  assert.equal(f.find(node => node.props["data-boat-map-view"]), undefined); assert.equal(frames.size, 0);
  assert.deepEqual(f.state.inventory, inventory);
  f.advanceTo(returns);
  assert.equal(f.find(node => node.props["data-boat-garage"] !== undefined), undefined, "the manifest opens on return");
  assert(f.find(node => node.props["data-boat-trip-summary"]));
  assert(f.find(node => node.props["data-trip-catch"] === 0));
  const accept = f.find(node => node.tag === "button" && text(node) === "Принять улов");
  accept.props.onClick(); accept.props.onClick(); f.render();
  assert.equal(f.pending.length, 1);
  assert.equal(f.find(node => node.props["data-boat-delivery"]), undefined, "a pending claim cannot announce delivery");
  assert.deepEqual(f.state.inventory, inventory);
  f.flush();
  assert.equal(f.find(node => node.props["data-boat-trip-summary"]), undefined);
  assert.equal(f.state.boat.voyage, undefined);
  assert.equal(Object.values(f.state.fishing.stock).reduce((sum, count) => sum + count, 0), 1);
  assert.equal(f.commands.filter(command => command.action === "claim_boat").length, 1);
  assert(f.find(node => node.props["data-boat-garage"] !== undefined), "confirmed delivery keeps the workshop open");
  assert(f.find(node => node.props["data-boat-delivery"] && node.props.role === "status"));
  assert.equal(f.find(node => node.tag === "button" && text(node) === "Готово"), undefined);
  f.close();
});

test("escaped or expired attempts never give local fish and the real cast budget survives scene remounts", () => {
  const f = fixture(); f.cast(); f.play();
  for (let i = 0; i <= f.state.boat.voyage.challenge.maxTicks && hooks.inspectReel().status === "active"; i++) f.frame(50);
  assert.equal(hooks.inspectReel().status, "escaped"); assert.equal(f.byAction("submit"), undefined); f.flush();
  assert.equal(f.state.boat.voyage.catches.length, 0); assert.equal(f.state.boat.voyage.castsUsed, 1);
  f.cast(); const id = f.state.boat.voyage.challenge.id, expiry = Date.parse(f.state.boat.voyage.challenge.expiresAt);
  f.advanceTo(expiry); f.frame(0);
  assert.equal(f.pending.length, 1); assert.equal(f.pending[0].reel.challengeId, id); assert.equal(f.pending[0].reel.missedBite, true);
  assert.equal(f.byAction("cast")?.props.disabled, false); assert.equal(f.byAction("submit"), undefined);
  f.flush(); assert(f.byAction("cast"));
  f.close(); f.reopen(); f.frame(0);
  assert.equal(f.state.boat.voyage.challenge, undefined); assert.equal(f.state.boat.voyage.castsUsed, 2);
  assert.equal(f.state.boat.voyage.catches.length, 0);
});


test("the fishing album shows confirmed species and permanent records without turning purchased stock into discoveries", () => {
  const f = fixture(), known = economyCatalog.fishing.fish[0], unknown = economyCatalog.fishing.fish[1];
  f.state.fishing.catches[known.itemId] = 3;
  f.state.boat.records[known.itemId] = { weightGrams: 1234, caughtAt: new Date(at).toISOString() };
  f.state.fishing.stock = { [unknown.itemId]: 12 };
  f.render(); f.click(f.byAction("album"));
  assert(f.find(node => node.props["data-boat-album-dialog"]));
  const discovered = f.find(node => node.props["data-album-fish"] === known.itemId);
  const locked = f.find(node => node.props["data-album-fish"] === unknown.itemId);
  assert.equal(discovered.props["data-discovered"], true); assert.match(text(discovered), /Поймано: 3/);
  assert.equal(locked.props["data-discovered"], false); assert.match(text(locked), /Неизвестная рыба/);
  assert.equal(text(locked).includes(unknown.description), false);
  const commands = f.commands.length;
  f.click(f.find(node => node.tag === "button" && text(node) === "Найденные"));
  assert.equal(f.find(node => node.props["data-album-fish"] === unknown.itemId), undefined);
  f.click(f.find(node => node.props["aria-label"] === "Закрыть альбом рыбака"));
  assert.equal(f.commands.length, commands); assert.equal(f.state.fishing.stock[unknown.itemId], 12);
  f.close(); f.reopen(); f.frame(0); f.click(f.byAction("album-shortcut"));
  assert.equal(f.find(node => node.props["data-album-fish"] === known.itemId).props["data-discovered"], true);
});

test("confirmed catch presentation celebrates a real weight record and never leaks its size before confirmation", () => {
  const f = fixture(); f.cast();
  const savedFish = f.state.boat.voyage.slots[0].fishId;
  f.state.boat.records[savedFish] = { weightGrams: 1, caughtAt: new Date(at).toISOString() };
  f.state.fishing.catches[savedFish] = 1; f.render();
  assert.equal(f.find(node => node.tag === "canvas").props.frame.fishSizeScale, undefined);
  f.play(); const result = f.playToResult(); assert.equal(result.status, "caught");
  assert.equal(f.find(node => node.props["data-confirmed-catch"]), undefined);
  assert.equal(f.byAction("submit"), undefined); f.flush();
  const receipt = f.find(node => node.props["data-confirmed-catch"]);
  assert.match(text(receipt), /Личный рекорд!/); assert.match(text(receipt), /Прежний: 1 г/);
  assert.doesNotMatch(text(receipt), /Новый вид/);
  const scene = f.find(node => node.tag === "canvas").props.frame;
  assert.equal(scene.fishId, savedFish); assert.ok(scene.fishSizeScale >= .78 && scene.fishSizeScale <= 1.3);
  assert.ok(scene.catchKey.endsWith(".0"));
  f.frame(4000); assert(f.find(node => node.props["data-confirmed-catch"]), "a record remains visible longer than an ordinary catch");
  f.frame(2001); assert.equal(f.find(node => node.props["data-confirmed-catch"]), undefined);
});

test("native long presses stay on the river across removal of a held reel and the final catch receipt", () => {
  const f = fixture();
  f.state.boat.voyage.maxCatches = 1;
  f.render();
  const surface = () => f.find(node => node.props["data-boat-water"]);
  const water = surface();
  const nativeEvent = type => new Event(type, { cancelable: true });
  assert.equal(water.dispatchEvent(nativeEvent("touchstart")), false);
  f.cast(); f.play();
  assert.equal(f.playToResult().status, "caught");
  assert.equal(f.byAction("hold"), undefined);
  assert.equal(surface(), water, "the native target outlives the reel button");
  assert.equal(water.dispatchEvent(nativeEvent("touchstart")), false, "a long press during confirmation cannot open an edit menu");
  assert.equal(water.dispatchEvent(nativeEvent("contextmenu")), false);
  f.flush();
  assert(f.find(node => node.props["data-fishing-finished"]));
  assert.equal(surface(), water);
  assert.equal(water.dispatchEvent(nativeEvent("selectstart")), false);
  assert.equal(water.dispatchEvent(nativeEvent("touchend")), false);
  assert.equal(f.byAction("return").dispatchEvent(nativeEvent("touchstart")), true);
  f.close();
  assert.equal(water.count(), 0);
});

test("the final confirmed fish keeps a prominent direct return action and then shows the actual onboard recap", () => {
  const f = fixture(); f.state.boat.voyage.maxCasts = 1; f.state.boat.voyage.slots = f.state.boat.voyage.slots.slice(0, 1); f.state.boat.voyage.maxCatches = 1; f.render();
  f.cast(); f.play(); assert.equal(f.playToResult().status, "caught");
  assert.equal(f.find(node => node.props["data-fishing-finished"]), undefined, "unconfirmed client success is not a completed fishing trip");
  assert.equal(f.byAction("submit"), undefined); f.flush();
  const caught = f.state.boat.voyage.catches[0], inventory = structuredClone(f.state.inventory);
  assert(f.find(node => node.props["data-confirmed-catch"] === caught.fishId), "preserve the last fish celebration");
  assert.equal(f.byAction("cast"), undefined);
  assert.equal(f.byAction("return").props["aria-label"], "Завершить рыбалку и вернуться домой");
  f.frame(6500);
  const recap = f.find(node => node.props["data-fishing-complete"] === f.state.boat.voyage.id);
  assert(recap); assert.match(text(recap), /Ящик полон|1 на борту/); assert.match(text(recap), /Самая крупная/);
  assert.equal(text(f.find(node => node.tag === "header")).includes("До возвращения"), false);
  assert(f.byAction("catch-details")); f.click(f.byAction("catch-details"));
  assert(f.find(node => node.props["data-boat-catch"] === caught.castIndex));
  f.click(f.find(node => node.props["aria-label"] === "Закрыть улов"));
  const returnButton = f.byAction("return"); f.click(returnButton); returnButton.props.onClick(event(returnButton));
  assert.equal(f.find(node => node.props.role === "alertdialog"), undefined);
  assert.equal(f.pending.filter(command => command.action === "return_boat").length, 1);
  f.flush(); assert.equal(f.find(node => node.props["data-boat-map-view"]), undefined);
  assert.deepEqual(f.state.inventory, inventory, "returning preserves the catch until unloading");
  assert.equal(f.commands.filter(command => command.action === "claim_boat").length, 0);
});

test("an exhausted empty trip and expired last attempt return directly after reopening without invented rewards", () => {
  const f = fixture(); f.state.boat.voyage.maxCasts = 1; f.state.boat.voyage.slots = f.state.boat.voyage.slots.slice(0, 1); f.render(); f.cast();
  f.advanceTo(Date.parse(f.state.boat.voyage.challenge.expiresAt)); f.frame(0);
  assert.equal(f.byAction("cast"), undefined); assert.equal(f.byAction("play"), undefined);
  assert.equal(f.pending.length, 1); assert.equal(f.pending[0].reel.missedBite, true); f.flush();
  assert(f.find(node => node.props["data-fishing-complete"]));
  assert.match(text(f.find(node => node.props["data-fishing-complete"])), /без улова/);
  f.close(); f.reopen(); f.frame(0);
  assert(f.byAction("return")); assert.equal(f.state.boat.voyage.catches.length, 0);
  f.click(f.byAction("return")); assert.equal(f.find(node => node.props.role === "alertdialog"), undefined);
  assert.equal(f.pending.length, 1); assert.equal(f.pending[0].action, "return_boat");
});

test("a live final reel crossing expiry resolves its trace before allowing a direct return", () => {
  const f = fixture(); f.state.boat.voyage.maxCasts = 1; f.state.boat.voyage.slots = f.state.boat.voyage.slots.slice(0, 1); f.render();
  f.cast(); f.play(); f.hold(true); f.frame(50);
  const before = f.find(node => node.tag === "canvas").props.frame;
  assert.equal(before.stage, "reeling"); assert.equal(before.held, true); assert(before.reel);
  const inventory = structuredClone(f.state.inventory), challenge = structuredClone(f.state.boat.voyage.challenge);
  f.advanceTo(Date.parse(challenge.expiresAt));
  assert.equal(f.find(node => node.props["data-fishing-complete"]), undefined);
  assert.equal(f.byAction("cast"), undefined);
  f.frame(0);
  const finished = f.find(node => node.tag === "canvas").props.frame, result = hooks.inspectReel();
  assert.equal(result.status, "escaped"); assert.equal(finished.stage, "escaped"); assert.equal(finished.held, false);
  assert.equal(f.pending.length, 1); assert.equal(f.pending[0].action, "submit_boat_cast");
  assert.deepEqual(replayBoatReel(challenge, f.pending[0].reel.inputs, f.pending[0].reel.endTick), result);
  assert.deepEqual(f.state.inventory, inventory); assert.equal(f.state.boat.voyage.catches.length, 0);
  f.flush();
  assert.equal(f.find(node => node.props["data-boat-reel"]), undefined);
  assert.equal(f.find(node => node.tag === "canvas").props.frame.reel, undefined);
  assert(f.find(node => node.props["data-fishing-complete"])); assert(f.byAction("return"));
  f.click(f.byAction("return")); assert.equal(f.find(node => node.props.role === "alertdialog"), undefined);
  assert.equal(f.pending.length, 1); assert.equal(f.pending[0].action, "return_boat");
});

test("a full fish box blocks unusable extra casts and returns directly", () => {
  const f = fixture(); f.state.boat.voyage.maxCatches = 1; f.render(); f.cast(); f.play(); assert.equal(f.playToResult().status, "caught");
  assert.equal(f.byAction("submit"), undefined); f.flush(); f.frame(6500);
  assert(f.state.boat.voyage.castsUsed < f.state.boat.voyage.maxCasts); assert.equal(f.byAction("cast"), undefined);
  f.click(f.byAction("return")); assert.equal(f.find(node => node.props.role === "alertdialog"), undefined);
  assert.equal(f.pending.length, 1);
});

test("return warning names only what an unfinished final cast can forfeit", () => {
  const f = fixture(); f.state.boat.voyage.maxCasts = 1; f.state.boat.voyage.slots = f.state.boat.voyage.slots.slice(0, 1); f.render(); f.cast();
  f.click(f.byAction("return")); const warning = f.find(node => node.props.role === "alertdialog");
  assert(warning); assert.match(text(warning), /Текущая рыба уйдёт/); assert.doesNotMatch(text(warning), /Оставшиеся забросы/);
  assert.equal(f.pending.length, 0);
});

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
const { replayBoatReel } = await vite.ssrLoadModule("/features/economy/domain/boat-reel.ts");
const { boatReelCheckpointKey } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-reel-checkpoint.ts");

const at = Date.parse("2026-11-03T10:00:00Z");
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
  const memory = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  Object.assign(globalThis, { window: Object.assign(new TrackedEvents(), { sessionStorage: memory }), document: Object.assign(new TrackedEvents(), { hidden: false, activeElement: null }),
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
  if (!host) { host = { tag: type, props, children: [], focus() { document.activeElement = this; }, scrollTo() {}, setPointerCapture(id) { this.captured = id; } }; hosts.set(childPath, host); }
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
  const apply = command => { const next = structuredClone(state); applyEconomyCommand(next, command, time, () => crypto.randomUUID(), {}, maximum => 37 % maximum); state = next; revision++; commands.push(command); };
  const command = (action, targetId, reel) => economyCommandSchema.parse({ requestId: crypto.randomUUID(), ownerPublicId: "0000-0000-0000", expectedRevision: revision, action, targetId, quantity: 1, totalPrice: 0, ...(reel ? { reel } : {}) });
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
      const economy = { snapshot: view(), now: time, snapshotConfirmed: true, busy, uncertain: false, retryAt: 0, error: null, devAvailable: dev,
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
  const flush = () => { for (const request of pending.splice(0)) apply(request); busy = false; render(); };
  render();
  return { render, find, byAction, click, frame, flush, view, pending, commands,
    get state() { return state; }, get tree() { return tree; },
    advanceTo(next) { const elapsed = next - time; assert(elapsed >= 0); time = next; clock += elapsed; render(); },
    close() { open = false; render(); }, reopen() { open = true; render(); },
    cast() { click(byAction("cast")); flush(); frame(0); },
    play() { const biteAt = Date.parse(state.boat.voyage.challenge.biteAt ?? state.boat.voyage.challenge.startedAt); if (time < biteAt) frame(biteAt - time); click(byAction("play")); frame(0); },
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
  assert.equal(f.find(node => node.tag === "canvas").props.frame.stage, "bite");
  assert(f.byAction("play"));
  assert.equal(f.find(node => node.tag === "canvas").props.frame.fishRarity, undefined, "the water scene cannot show the upcoming catch class");
  assert.equal(f.view().boat.voyage.challenge.fishId, undefined);
  assert.equal(f.view().boat.voyage.challenge.weightGrams, undefined);
  assert.equal(f.commands.filter(request => request.action === "submit_boat_cast").length, 0);
});

test("real play and input handlers pause for catch album DEV and return overlays without spending a return or generating fish", () => {
  const f = fixture({ dev: true }); f.cast(); f.play();
  f.hold(true, "pointer"); assert.equal(f.byAction("hold").props["aria-pressed"], true);
  f.frame(50); f.hold(false, "pointer"); assert.equal(f.byAction("hold").props["aria-pressed"], false);
  f.hold(true); f.frame(50); f.hold(false); const initialInventory = structuredClone(f.state.inventory);
  const overlays = [() => f.find(node => node.tag === "button" && text(node).startsWith("Улов ·")),
    () => f.find(node => node.tag === "button" && text(node) === "DEV"), () => f.byAction("return"), () => f.byAction("album")];
  for (let index = 0; index < overlays.length; index++) {
    if (f.byAction("play")) f.play();
    f.frame(50); const tick = hooks.inspectReel().tick;
    f.click(overlays[index]()); assert.equal(f.find(node => node.props["data-reel-status"] === "paused") != null, true);
    f.frame(200); assert.equal(hooks.inspectReel().tick, tick); assert.equal(f.state.boat.voyage.catches.length, 0);
    assert.equal(f.commands.filter(request => request.action === "return_boat").length, 0);
    if (index === 0) f.click(f.find(node => node.props["aria-label"] === "Закрыть улов"));
    else if (index === 1) f.click(overlays[index]());
    else if (index === 2) f.click(f.find(node => node.tag === "button" && text(node) === "Остаться"));
    else f.click(f.find(node => node.props["aria-label"] === "Закрыть альбом рыбака"));
    assert(f.byAction("play"), "Dismissing a tray keeps manual play paused");
  }
  assert.deepEqual(f.state.inventory, initialInventory);
});

test("close reopen and hidden events preserve the same tab checkpoint paused without duplicate frames or commands", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); f.cast(); f.play(); f.hold(true); f.frame(100);
  const voyageId = f.state.boat.voyage.id, challenge = f.state.boat.voyage.challenge, tick = hooks.inspectReel().tick;
  f.click(f.find(node => node.tag === "button" && text(node) === "К поляне"));
  assert(f.find(node => node.props["data-leaving"]));
  assert.equal(hooks.inspectReel().tick, tick);
  t.mock.timers.tick(260); f.render();
  assert.equal(frames.size, 0); assert.equal(window.count(), 0); assert.equal(document.count(), 0);
  const key = boatReelCheckpointKey("0000-0000-0000", voyageId, challenge.id);
  assert.equal(JSON.parse(storage.get(key)).endTick, tick);
  f.reopen(); f.frame(0);
  assert.equal(f.state.boat.voyage.id, voyageId); assert.equal(f.state.boat.voyage.challenge.id, challenge.id);
  assert.equal(hooks.inspectReel().tick, tick); assert(f.byAction("play")); assert.equal(frames.size, 1);
  assert.equal(window.count(), 1); assert.equal(document.count(), 1);
  f.play(); f.hold(true); f.frame(50); const beforeHidden = hooks.inspectReel().tick;
  document.hidden = true; document.dispatchEvent(new Event("visibilitychange")); f.render();
  f.frame(500); assert.equal(hooks.inspectReel().tick, beforeHidden); assert(f.byAction("play"));
  document.hidden = false; document.dispatchEvent(new Event("visibilitychange")); f.render();
  assert.equal(f.state.boat.voyage.catches.length, 0); assert.equal(f.commands.filter(request => request.action === "begin_boat_cast").length, 1);
  f.close(); assert.equal(frames.size, 0); assert.equal(window.count() + document.count(), 0);
});

test("caught UI explicitly submits one replay verified trace then credits inventory only after confirmed return and unloading", () => {
  const f = fixture(); f.cast(); f.play(); const inventory = structuredClone(f.state.inventory), challenge = structuredClone(f.state.boat.voyage.challenge);
  const result = f.playToResult(); assert.equal(result.status, "caught");
  assert.equal(f.find(node => node.tag === "canvas").props.frame.stage, "caught");
  assert.deepEqual(f.state.inventory, inventory); assert.equal(f.state.boat.voyage.catches.length, 0);
  assert.equal(f.find(node => node.props["data-confirmed-catch"]), undefined);
  const staleSubmit = f.byAction("submit"); f.click(staleSubmit); staleSubmit.props.onClick(event(staleSubmit));
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
  assert(f.find(node => node.props["data-boat-trip-summary"] && node.props["data-delivered"] === false));
  f.click(f.find(node => node.tag === "button" && text(node) === "Забрать улов"));
  assert.equal(f.find(node => node.props["data-boat-trip-summary"] && node.props["data-delivered"] === true), undefined, "a pending claim cannot claim delivery");
  f.flush();
  assert(f.find(node => node.props["data-boat-trip-summary"] && node.props["data-delivered"] === true));
  assert.equal(f.state.boat.voyage, undefined);
  assert.equal(Object.values(f.state.fishing.stock).reduce((sum, count) => sum + count, 0), 1);
  assert.equal(f.commands.filter(command => command.action === "claim_boat").length, 1);
  f.click(f.find(node => node.props["data-boat-trip-done"]));
  assert.equal(flatten(f.tree).length, 0);
});

test("escaped or expired attempts never give local fish and the real cast budget survives scene remounts", () => {
  const f = fixture(); f.cast(); f.play();
  for (let i = 0; i <= f.state.boat.voyage.challenge.maxTicks && hooks.inspectReel().status === "active"; i++) f.frame(50);
  assert.equal(hooks.inspectReel().status, "escaped"); f.click(f.byAction("submit")); f.flush();
  assert.equal(f.state.boat.voyage.catches.length, 0); assert.equal(f.state.boat.voyage.castsUsed, 1);
  f.cast(); const id = f.state.boat.voyage.challenge.id, expiry = Date.parse(f.state.boat.voyage.challenge.expiresAt);
  f.advanceTo(expiry); f.frame(0);
  assert(f.find(node => node.props["data-reel-status"] === "expired")); assert(f.byAction("cast"));
  assert.equal(f.byAction("submit"), undefined); assert.equal(f.state.boat.voyage.catches.length, 0);
  f.close(); f.reopen(); f.frame(0);
  assert.equal(f.state.boat.voyage.challenge.id, id); assert.equal(f.state.boat.voyage.castsUsed, 2);
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
  f.click(f.byAction("submit")); f.flush();
  const receipt = f.find(node => node.props["data-confirmed-catch"]);
  assert.match(text(receipt), /Личный рекорд!/); assert.match(text(receipt), /Прежний: 1 г/);
  assert.doesNotMatch(text(receipt), /Новый вид/);
  const scene = f.find(node => node.tag === "canvas").props.frame;
  assert.equal(scene.fishId, savedFish); assert.ok(scene.fishSizeScale >= .78 && scene.fishSizeScale <= 1.3);
  assert.ok(scene.catchKey.endsWith(".0"));
  f.frame(4000); assert(f.find(node => node.props["data-confirmed-catch"]), "a record remains visible longer than an ordinary catch");
  f.frame(2001); assert.equal(f.find(node => node.props["data-confirmed-catch"]), undefined);
});

test("the final confirmed fish keeps a prominent direct return action and then shows the actual onboard recap", () => {
  const f = fixture(); f.state.boat.voyage.maxCasts = 1; f.state.boat.voyage.slots = f.state.boat.voyage.slots.slice(0, 1); f.state.boat.voyage.maxCatches = 1; f.render();
  f.cast(); f.play(); assert.equal(f.playToResult().status, "caught");
  assert.equal(f.find(node => node.props["data-fishing-finished"]), undefined, "unconfirmed client success is not a completed fishing trip");
  f.click(f.byAction("submit")); f.flush();
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
  assert(f.find(node => node.props["data-fishing-complete"]));
  assert.match(text(f.find(node => node.props["data-fishing-complete"])), /без улова/);
  f.close(); f.reopen(); f.frame(0);
  assert(f.byAction("return")); assert.equal(f.state.boat.voyage.catches.length, 0);
  f.click(f.byAction("return")); assert.equal(f.find(node => node.props.role === "alertdialog"), undefined);
  assert.equal(f.pending.length, 1); assert.equal(f.pending[0].action, "return_boat");
});

test("a live final reel crossing expiry clears stale held fish and resistance before its controller unmounts", () => {
  const f = fixture(); f.state.boat.voyage.maxCasts = 1; f.state.boat.voyage.slots = f.state.boat.voyage.slots.slice(0, 1); f.render();
  f.cast(); f.play(); f.hold(true); f.frame(50);
  const before = f.find(node => node.tag === "canvas").props.frame;
  assert.equal(before.stage, "reeling"); assert.equal(before.held, true); assert(before.reel);
  const inventory = structuredClone(f.state.inventory);
  f.advanceTo(Date.parse(f.state.boat.voyage.challenge.expiresAt));
  const expired = f.find(node => node.tag === "canvas").props.frame;
  assert.equal(expired.stage, "expired"); assert.equal(expired.held, false);
  assert.equal(expired.reel, undefined); assert.equal(expired.resistancePhase, undefined);
  assert.equal(f.find(node => node.props["data-boat-reel"]), undefined);
  assert(f.find(node => node.props["data-fishing-complete"])); assert(f.byAction("return"));
  assert.equal(frames.size, 0); assert.equal(f.pending.length, 0);
  assert.deepEqual(f.state.inventory, inventory); assert.equal(f.state.boat.voyage.catches.length, 0);
  f.click(f.byAction("return")); assert.equal(f.find(node => node.props.role === "alertdialog"), undefined);
  assert.equal(f.pending.length, 1); assert.equal(f.pending[0].action, "return_boat");
});

test("a full fish box blocks unusable extra casts and returns directly", () => {
  const f = fixture(); f.state.boat.voyage.maxCatches = 1; f.render(); f.cast(); f.play(); assert.equal(f.playToResult().status, "caught");
  f.click(f.byAction("submit")); f.flush(); f.frame(6500);
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

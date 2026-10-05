import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:world-character-navigation-hooks";
// Keep WorldView's real event handlers and state transitions while leaving the
// canvas/portals unmounted. This scoped hook adapter avoids a browser dependency.
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "character-navigation-hooks", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots = [], cursor = 0;
      export function reset() { slots = []; cursor = 0; }
      export function render() { cursor = 0; }
      export function useState(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
        return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
      }
      export function useRef(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = { current: initial };
        return slots[index];
      }
      export function useMemo(callback) { return callback(); }
      export function useCallback(callback) { return callback; }
      export function useEffect() {}
    `; },
    transform(source, id) {
      if (id.endsWith("/features/world/world-view.tsx")) return source.replace('from "react";', `from "${hookModule}";`);
    },
  }],
});
after(() => vite.close());
const { WORLD_CHARACTERS, worldCharacterResident } = await vite.ssrLoadModule("/features/world/world-characters-model.ts");
const { WorldCharacters } = await vite.ssrLoadModule("/features/world/world-characters.tsx");
const { default: WorldView } = await vite.ssrLoadModule("/features/world/world-view.tsx");
const hooks = await vite.ssrLoadModule(hookModule);

function elements(tree) {
  const found = [];
  function visit(element) {
    if (!isValidElement(element)) return;
    found.push(element); Children.forEach(element.props.children, visit);
  }
  visit(tree); return found;
}

test("the library has one implemented resident and four nameless immutable unknown slots", () => {
  assert.equal(WORLD_CHARACTERS.length, 5);
  assert.deepEqual(WORLD_CHARACTERS.filter(item => item.available).map(item => item.id), ["plesk"]);
  assert.equal(Object.isFrozen(WORLD_CHARACTERS), true);
  for (const item of WORLD_CHARACTERS) {
    assert.equal(Object.isFrozen(item), true);
    assert.equal(worldCharacterResident(item.id), item.available ? "plesk" : null);
    if (!item.available) for (const field of ["name", "role", "unlock", "cost"]) assert.equal(field in item, false);
  }
  for (const id of ["unknown", "home", "mochlik", "", "__proto__"]) assert.equal(worldCharacterResident(id), null);
});

test("disclosure labels its state and exposes only Pleska as a conversation action", () => {
  let toggles = 0;
  const residents = [], props = { expanded: false, onToggle() { toggles++; }, onResident: id => residents.push(id) };
  const closed = WorldCharacters(props);
  const trigger = elements(closed).find(element => element.props["data-world-characters-trigger"] !== undefined);
  assert.equal(trigger.props["aria-expanded"], false); trigger.props.onClick(); assert.equal(toggles, 1);
  const closedHtml = renderToStaticMarkup(closed);
  assert.match(closedHtml, /Персонажи/); assert.doesNotMatch(closedHtml, /Плёска|<ul|<canvas/);
  const opened = WorldCharacters({ ...props, expanded: true });
  const html = renderToStaticMarkup(opened), buttons = elements(opened).filter(element => element.type === "button");
  assert.match(html, /aria-expanded="true" aria-controls="world-characters-list"/);
  assert.match(html, /<ul[^>]+aria-label="Персонажи леса"/);
  assert.equal(buttons.filter(element => element.props.disabled).length, 4);
  for (const button of buttons.filter(element => element.props.disabled)) {
    assert.equal(button.props.onClick, undefined); assert.equal(button.props["aria-haspopup"], undefined);
    assert.equal(button.props["aria-label"], "Неизвестный персонаж, пока недоступен");
  }
  const available = buttons.find(element => element.props["data-world-character"] === "plesk");
  assert.equal(available.props["aria-haspopup"], "dialog"); available.props.onClick();
  assert.deepEqual(residents, ["plesk"]);
  assert.equal((html.match(/class="[^\"]*question[^\"]*"/g) ?? []).length, 4);
  assert.doesNotMatch(html, /Шишколап|Лопоух|Камнешмыг|Листохвост|Разблокировать|Купить|<img/);
});

function navigation() {
  hooks.reset();
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const savedElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  const focused = [];
  class Element { constructor(name) { this.name = name; this.isConnected = true; } focus() { focused.push(this.name); } }
  const trigger = new Element("more"), card = new Element("plesk"), map = new Element("map");
  Object.defineProperty(globalThis, "HTMLElement", { value: Element, configurable: true });
  Object.defineProperty(globalThis, "document", { value: { activeElement: map }, configurable: true });
  const state = { resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1,
    workshop: false, journeys: [], collection: [], inventory: [], equipment: {}, completedJourneys: 0 };
  const world = { snapshot: { state, gifts: [] }, now: Date.parse("2026-10-05T12:00:00Z"), act() { assert.fail("navigation cannot mutate world"); } };
  const economy = { snapshot: null, now: world.now, busy: false, uncertain: false, retryAt: 0,
    act() { assert.fail("navigation cannot issue economy commands"); }, retry() {} };
  const props = { world, economy, ownerPublicId: "characters-test", timeZone: "UTC", onClose() {}, displayName: "Мохлик", level: 1, wakeSignal: 0, bestStreakDays: 1 };
  let view;
  const render = () => {
    hooks.render(); view = WorldView(props);
    view.props.ref.current = { querySelector(selector) { return selector.includes("data-world-character") ? card : trigger; } };
    return elements(view);
  };
  const find = callback => render().find(callback);
  const component = name => find(element => typeof element.type === "function" && element.type.name === name);
  const restore = () => {
    if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument); else delete globalThis.document;
    if (savedElement) Object.defineProperty(globalThis, "HTMLElement", savedElement); else delete globalThis.HTMLElement;
  };
  return { find, component, render, focused, restore };
}

test("More reveals characters, then Back, close and Escape's close action restore the expanded list and card focus", () => {
  for (const exit of ["onBack", "onClose"]) {
    const nav = navigation();
    try {
      nav.find(element => element.props["data-world-quick"] === "more").props.onClick();
      let library = nav.component("WorldCharacters"); assert.equal(library.props.expanded, false);
      library.props.onToggle(); library = nav.component("WorldCharacters"); assert.equal(library.props.expanded, true);
      library.props.onResident("plesk");
      let dialog = nav.component("WorldResidentDialog"); assert.equal(dialog.props.open, true); assert.equal(typeof dialog.props.onBack, "function");
      assert.equal(nav.component("WorldCharacters"), undefined, "the quick menu closes behind the modal");
      dialog.props[exit](); dialog = nav.component("WorldResidentDialog"); assert.equal(dialog.props.open, false);
      library = nav.component("WorldCharacters"); assert.equal(library.props.expanded, true);
      let prevented = false; dialog.props.onCloseAutoFocus({ preventDefault() { prevented = true; } });
      assert.equal(prevented, true); assert.deepEqual(nav.focused, ["plesk"]);
      nav.find(element => element.props["data-world-quick"] === "more").props.onClick();
      nav.find(element => element.props["data-world-quick"] === "more").props.onClick();
      assert.equal(nav.component("WorldCharacters").props.expanded, false, "a fresh More visit starts folded");
    } finally { nav.restore(); }
  }
});

test("map and pantry conversation entries keep their return paths, while fishing leaves the library", () => {
  const nav = navigation();
  try {
    nav.component("WorldScene").props.onResident("plesk");
    let dialog = nav.component("WorldResidentDialog"); assert.equal(dialog.props.onBack, undefined);
    dialog.props.onClose(); dialog = nav.component("WorldResidentDialog"); dialog.props.onCloseAutoFocus({ preventDefault() {} });
    assert.deepEqual(nav.focused, ["map"]); assert.equal(nav.component("WorldCharacters"), undefined);
    nav.find(element => element.props["data-world-quick"] === "pantry").props.onClick();
    nav.component("WorldPantryMenu").props.onOpenFishingShop();
    dialog = nav.component("WorldResidentDialog"); assert.equal(dialog.props.onBack, undefined);
    dialog.props.onClose(); dialog = nav.component("WorldResidentDialog"); dialog.props.onCloseAutoFocus({ preventDefault() {} });
    assert.deepEqual(nav.focused, ["map", "more"]);
    nav.find(element => element.props["data-world-quick"] === "more").props.onClick();
    nav.component("WorldCharacters").props.onToggle(); nav.component("WorldCharacters").props.onResident("plesk");
    nav.component("WorldResidentDialog").props.onFishing();
    assert.equal(nav.component("WorldResidentDialog").props.open, false);
    assert.equal(nav.component("WorldCharacters"), undefined);
    assert.equal(nav.component("WorldExpeditionsMenu").props.initialSector, "shore");
  } finally { nav.restore(); }
});

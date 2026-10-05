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

test("a separate modal gallery has one large animated resident and four nameless noninteractive silhouettes", () => {
  const residents = []; let closed = 0;
  const gallery = WorldCharacters({ open: true, onClose() { closed++; }, onCloseAutoFocus() {}, onResident: id => residents.push(id) });
  assert.equal(gallery.props.open, true);
  gallery.props.onOpenChange(false); assert.equal(closed, 1);
  const nodes = elements(gallery), list = nodes.find(element => element.type === "ul");
  const html = renderToStaticMarkup(list);
  const available = nodes.find(element => element.props["data-world-character"] === "plesk");
  assert.equal(available.props["aria-haspopup"], "dialog"); available.props.onClick(); assert.deepEqual(residents, ["plesk"]);
  assert.equal(nodes.filter(element => element.props["aria-label"] === "Неизвестный персонаж, пока недоступен").length, 4);
  for (const node of nodes.filter(element => element.props["aria-label"] === "Неизвестный персонаж, пока недоступен")) {
    assert.equal(node.type, "div"); assert.equal(node.props.onClick, undefined); assert.equal(node.props.tabIndex, undefined);
  }
  assert.equal(elements(available).find(element => element.type.name === "PleskPortrait").props.animated, true);
  assert.equal(list.props.children[0].key, "plesk", "the only available resident is first");
  assert.equal((html.match(/<canvas/g) ?? []).length, 1);
  assert.equal((html.match(/class="[^\"]*question[^\"]*"/g) ?? []).length, 4);
  assert.doesNotMatch(html, /Шишколап|Лопоух|Камнешмыг|Листохвост|Разблокировать|Купить|<img/);
  const content = nodes.find(element => element.props["data-slot"] === "dialog-content");
  let prevented = false, focused = false;
  content.props.onOpenAutoFocus({ target: { querySelector(selector) { assert.equal(selector, '[data-world-character="plesk"]'); return { focus() { focused = true; } }; } }, preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(focused, true, "portal autofocus targets its own card, not the world DOM");
});

function navigation() {
  hooks.reset();
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const savedElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  const focused = [];
  class Element { constructor(name) { this.name = name; this.isConnected = true; } focus() { focused.push(this.name); } }
  const trigger = new Element("more"), characterTrigger = new Element("characters"), card = new Element("plesk"), map = new Element("map");
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
    view.props.ref.current = { querySelector(selector) { return selector.includes("data-world-characters-trigger") ? characterTrigger : selector.includes("data-world-character=") ? card : trigger; } };
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

test("More opens a separate gallery; conversation Back/close return there and gallery close restores its menu trigger", () => {
  for (const exit of ["onBack", "onClose"]) {
    const nav = navigation();
    try {
      nav.find(element => element.props["data-world-quick"] === "more").props.onClick();
      assert.equal(nav.component("WorldCharacters").props.open, false);
      nav.find(element => element.props["data-world-characters-trigger"] !== undefined).props.onClick();
      let library = nav.component("WorldCharacters"); assert.equal(library.props.open, true);
      assert.equal(nav.find(element => element.props.id === "world-quick-menu"), undefined, "More is gone behind the gallery");
      library.props.onResident("plesk"); library = nav.component("WorldCharacters"); assert.equal(library.props.open, false);
      let prevented = false; library.props.onCloseAutoFocus({ preventDefault() { prevented = true; } });
      assert.equal(prevented, true); assert.deepEqual(nav.focused, [], "switching modals must not focus the hidden More menu");
      let dialog = nav.component("WorldResidentDialog"); assert.equal(dialog.props.open, true); assert.equal(typeof dialog.props.onBack, "function");
      dialog.props[exit](); dialog = nav.component("WorldResidentDialog"); assert.equal(dialog.props.open, false);
      assert.equal(nav.component("WorldCharacters").props.open, true);
      dialog.props.onCloseAutoFocus({ preventDefault() {} });
      assert.deepEqual(nav.focused, [], "gallery open autofocus owns focus inside its portal");
      library = nav.component("WorldCharacters"); library.props.onClose();
      library = nav.component("WorldCharacters"); assert.equal(library.props.open, false);
      library.props.onCloseAutoFocus({ preventDefault() {} });
      assert.deepEqual(nav.focused, ["characters"]);
      assert.ok(nav.find(element => element.props.id === "world-quick-menu"));
      assert.ok(nav.find(element => element.props["data-world-characters-trigger"] !== undefined));
    } finally { nav.restore(); }
  }
});

test("map and pantry conversation entries keep their return paths, while fishing leaves the gallery", () => {
  const nav = navigation();
  try {
    nav.component("WorldScene").props.onResident("plesk");
    let dialog = nav.component("WorldResidentDialog"); assert.equal(dialog.props.onBack, undefined);
    dialog.props.onClose(); dialog = nav.component("WorldResidentDialog"); dialog.props.onCloseAutoFocus({ preventDefault() {} });
    assert.deepEqual(nav.focused, ["map"]); assert.equal(nav.component("WorldCharacters").props.open, false);
    nav.find(element => element.props["data-world-quick"] === "pantry").props.onClick();
    nav.component("WorldPantryMenu").props.onOpenFishingShop();
    dialog = nav.component("WorldResidentDialog"); assert.equal(dialog.props.onBack, undefined);
    dialog.props.onClose(); dialog = nav.component("WorldResidentDialog"); dialog.props.onCloseAutoFocus({ preventDefault() {} });
    assert.deepEqual(nav.focused, ["map", "more"]);
    nav.find(element => element.props["data-world-quick"] === "more").props.onClick();
    nav.find(element => element.props["data-world-characters-trigger"] !== undefined).props.onClick();
    nav.component("WorldCharacters").props.onResident("plesk");
    nav.component("WorldResidentDialog").props.onFishing();
    assert.equal(nav.component("WorldResidentDialog").props.open, false);
    assert.equal(nav.component("WorldCharacters").props.open, false);
    assert.equal(nav.component("WorldExpeditionsMenu").props.initialSector, "shore");
  } finally { nav.restore(); }
});

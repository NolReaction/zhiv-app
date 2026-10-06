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

test("the library has two implemented residents and three nameless immutable unknown slots", () => {
  assert.equal(WORLD_CHARACTERS.length, 5);
  assert.deepEqual(WORLD_CHARACTERS.filter(item => item.available).map(item => item.id), ["builder", "plesk"]);
  assert.equal(Object.isFrozen(WORLD_CHARACTERS), true);
  for (const item of WORLD_CHARACTERS) {
    assert.equal(Object.isFrozen(item), true);
    assert.equal(worldCharacterResident(item.id), item.available ? item.id : null);
    if (!item.available) for (const field of ["name", "role", "unlock", "cost"]) assert.equal(field in item, false);
  }
  for (const id of ["unknown", "unknown-1", "home", "mochlik", "", "__proto__"]) assert.equal(worldCharacterResident(id), null);
});

test("a separate modal gallery has each resident's animated portrait and three nameless noninteractive silhouettes", () => {
  const residents = []; let closed = 0;
  const gallery = WorldCharacters({ open: true, onClose() { closed++; }, onCloseAutoFocus() {}, onResident: id => residents.push(id) });
  assert.equal(gallery.props.open, true);
  gallery.props.onOpenChange(false); assert.equal(closed, 1);
  const nodes = elements(gallery), list = nodes.find(element => element.type === "ul");
  const html = renderToStaticMarkup(list);
  const available = nodes.find(element => element.props["data-world-character"] === "plesk");
  assert.equal(available.props["aria-haspopup"], "dialog"); available.props.onClick(); assert.deepEqual(residents, ["plesk"]);
  const builder = nodes.find(element => element.props["data-world-character"] === "builder");
  assert.equal(builder.props["aria-haspopup"], "dialog"); builder.props.onClick(); assert.deepEqual(residents, ["plesk", "builder"]);
  assert.equal(nodes.filter(element => element.props["aria-label"] === "Неизвестный персонаж, пока недоступен").length, 3);
  for (const node of nodes.filter(element => element.props["aria-label"] === "Неизвестный персонаж, пока недоступен")) {
    assert.equal(node.type, "div"); assert.equal(node.props.onClick, undefined); assert.equal(node.props.tabIndex, undefined);
  }
  assert.equal(elements(available).find(element => element.type.name === "PleskPortrait").props.animated, true);
  assert.equal(elements(builder).find(element => element.type.name === "BuilderPortrait").props.animated, true);
  assert.deepEqual(list.props.children.slice(0, 2).map(item => item.key), ["builder", "plesk"], "available residents precede locked slots");
  assert.equal((html.match(/<canvas/g) ?? []).length, 2);
  assert.equal((html.match(/class="[^\"]*question[^\"]*"/g) ?? []).length, 3);
  assert.match(html, /Шишколап/);
  assert.doesNotMatch(html, /Лопоух|Камнешмыг|Листохвост|Разблокировать|Купить|<img/);
  const content = nodes.find(element => element.props["data-slot"] === "dialog-content");
  let prevented = false, focused = false;
  content.props.onOpenAutoFocus({ target: { querySelector(selector) { assert.equal(selector, 'button[data-world-character]'); return { focus() { focused = true; } }; } }, preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(focused, true, "portal autofocus targets its own card, not the world DOM");
  for (const id of ["builder", "plesk"]) {
    const returning = WorldCharacters({ open: true, onClose() {}, onCloseAutoFocus() {}, onResident() {}, focusedResident: id });
    const returningContent = elements(returning).find(element => element.props["data-slot"] === "dialog-content");
    let returned = false;
    returningContent.props.onOpenAutoFocus({ target: { querySelector(selector) {
      assert.equal(selector, `button[data-world-character="${id}"]`); return { focus() { returned = true; } };
    } }, preventDefault() {} });
    assert.equal(returned, true, `returning from ${id} restores that resident's card`);
  }
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
  for (const resident of ["plesk", "builder"]) for (const exit of ["onBack", "onClose"]) {
    const nav = navigation();
    const dialogName = resident === "builder" ? "WorldBuilderDialog" : "WorldResidentDialog";
    try {
      nav.find(element => element.props["data-world-quick"] === "more").props.onClick();
      assert.equal(nav.component("WorldCharacters").props.open, false);
      nav.find(element => element.props["data-world-characters-trigger"] !== undefined).props.onClick();
      let library = nav.component("WorldCharacters"); assert.equal(library.props.open, true);
      assert.equal(nav.find(element => element.props.id === "world-quick-menu"), undefined, "More is gone behind the gallery");
      library.props.onResident(resident); library = nav.component("WorldCharacters"); assert.equal(library.props.open, false);
      let prevented = false; library.props.onCloseAutoFocus({ preventDefault() { prevented = true; } });
      assert.equal(prevented, true); assert.deepEqual(nav.focused, [], "switching modals must not focus the hidden More menu");
      let dialog = nav.component(dialogName); assert.equal(dialog.props.open, true); assert.equal(typeof dialog.props.onBack, "function");
      assert.equal(nav.component(resident === "builder" ? "WorldResidentDialog" : "WorldBuilderDialog").props.open, false, "only the requested resident opens");
      dialog.props[exit](); dialog = nav.component(dialogName); assert.equal(dialog.props.open, false);
      assert.equal(nav.component("WorldCharacters").props.open, true);
      assert.equal(nav.component("WorldCharacters").props.focusedResident, resident, "gallery autofocus returns to the same character");
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

test("the builder opens from the map and leaving his conversation selects the exact paid upgrade", () => {
  const nav = navigation();
  try {
    nav.component("WorldScene").props.onResident("builder");
    let dialog = nav.component("WorldBuilderDialog"); assert.equal(dialog.props.open, true); assert.equal(dialog.props.onBack, undefined);
    assert.equal(nav.component("WorldResidentDialog").props.open, false);
    dialog.props.onClose(); dialog = nav.component("WorldBuilderDialog"); dialog.props.onCloseAutoFocus({ preventDefault() {} });
    assert.deepEqual(nav.focused, ["map"]); assert.equal(nav.component("WorldCharacters").props.open, false);
    nav.find(element => element.props["data-world-quick"] === "more").props.onClick();
    nav.find(element => element.props["data-world-characters-trigger"] !== undefined).props.onClick();
    nav.component("WorldCharacters").props.onResident("builder");
    nav.component("WorldBuilderDialog").props.onOpenConstruction("warehouse");
    dialog = nav.component("WorldBuilderDialog"); assert.equal(dialog.props.open, false);
    assert.equal(nav.component("WorldCharacters").props.open, false);
    assert.equal(nav.component("WorldUpgradeDialog").props.stationId, "warehouse");
    dialog.props.onCloseAutoFocus({ preventDefault() {} });
    assert.deepEqual(nav.focused, ["map"], "opening the upgrade must not refocus the hidden gallery");
  } finally { nav.restore(); }
});

test("map and pantry conversation entries keep their return paths, while fishing leaves the gallery", () => {
  const nav = navigation();
  try {
    nav.component("WorldScene").props.onResident("plesk");
    let dialog = nav.component("WorldResidentDialog"); assert.equal(dialog.props.onBack, undefined);
    dialog.props.onClose(); dialog = nav.component("WorldResidentDialog"); dialog.props.onCloseAutoFocus({ preventDefault() {} });
    assert.deepEqual(nav.focused, ["map"]); assert.equal(nav.component("WorldCharacters").props.open, false);
    nav.find(element => element.props["data-world-quick"] === "pantry").props.onClick();
    nav.component("WorldPantryMenu").props.onOpenFishingShop({ type: "click" });
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
    nav.component("WorldExpeditionsMenu").props.onOpenFishingShop({ type: "click" });
    assert.equal(nav.component("WorldResidentDialog").props.open, true, "an actual button event cannot become the resident ID");
    assert.equal(nav.component("WorldBuilderDialog").props.open, false);
  } finally { nav.restore(); }
});

test("gifts open manually from My Mochlik while call and reward closing preserve the profile", () => {
  const nav = navigation();
  try {
    const original = nav.component("DailyRewardsDialog");
    assert.equal(original.props.open, false);
    assert.equal(original.key, "characters-test", "the persistent reward controller is keyed to its owner");
    assert.equal(nav.component("DailyRewardsButton"), undefined, "there is no standalone map gift button");
    nav.find(element => element.props["data-world-quick"] === "profile").props.onClick();
    let profile = nav.component("WorldProfileMenu");
    assert.equal(profile.props.rewards.type.name, "DailyRewardsButton");
    const wake = nav.component("WorldScene").props.wakeSignal;
    profile.props.onCall();
    profile = nav.component("WorldProfileMenu"); assert.ok(profile, "calling does not dismiss the profile");
    assert.equal(nav.component("WorldScene").props.wakeSignal, wake + 1);
    profile.props.rewards.props.onRequestOpen();
    let gifts = nav.component("DailyRewardsDialog"); assert.equal(gifts.props.open, true);
    assert.ok(nav.component("WorldProfileMenu"), "the profile remains behind the gift dialog");
    const trigger = profile.props.rewards.props.triggerRef;
    trigger.current = { isConnected: true, focus() { nav.focused.push("gifts"); } };
    gifts.props.onOpenChange(false); gifts = nav.component("DailyRewardsDialog");
    assert.equal(gifts.props.open, false); assert.equal(gifts.key, original.key);
    assert.ok(nav.component("WorldProfileMenu")); gifts.props.onReturnFocus(); assert.deepEqual(nav.focused, ["gifts"]);
    nav.find(element => element.props["aria-label"] === "Закрыть: Мой Мохлик").props.onClick();
    assert.equal(nav.component("WorldProfileMenu"), undefined);
    assert.equal(nav.component("DailyRewardsDialog").key, original.key, "closing the profile keeps receipt resolution mounted");
  } finally { nav.restore(); }
});

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
      export function useMemo(callback, dependencies) {
        const index = cursor++, previous = slots[index];
        if (!previous || !dependencies || dependencies.some((value, position) => !Object.is(value, previous.dependencies?.[position]))) {
          slots[index] = { value: callback(), dependencies };
        }
        return slots[index].value;
      }
      export function useCallback(callback) { return callback; }
      export function useEffect() {}
      export function useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); }
    `; },
    transform(source, id) {
      if (id.endsWith("/features/world/world-view.tsx") || id.endsWith("/features/economy/use-construction-goal.ts")) {
        return source.replace('from "react";', `from "${hookModule}";`);
      }
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
  class Element { constructor(name) { this.name = name; this.isConnected = true; this.dataset = {}; } focus() { focused.push(this.name); } }
  const trigger = new Element("more"), characterTrigger = new Element("characters"), card = new Element("plesk"), map = new Element("map");
  Object.defineProperty(globalThis, "HTMLElement", { value: Element, configurable: true });
  Object.defineProperty(globalThis, "document", { value: { activeElement: map }, configurable: true });
  const state = { resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1,
    workshop: false, journeys: [], collection: [], inventory: [], equipment: {}, completedJourneys: 0 };
  const world = { snapshot: { state, gifts: [] }, now: Date.parse("2026-10-05T12:00:00Z"), act() { assert.fail("navigation cannot mutate world"); } };
  let refreshes = 0;
  const economy = { snapshot: null, now: world.now, busy: false, uncertain: false, retryAt: 0,
    act() { assert.fail("navigation cannot issue economy commands"); }, retry() {}, refresh() { refreshes++; return Promise.resolve(); } };
  const props = { world, economy, ownerPublicId: "characters-test", timeZone: "UTC", onClose() {}, displayName: "Мохлик", level: 1, wakeSignal: 0, bestStreakDays: 1 };
  let view;
  const render = () => {
    hooks.render(); view = WorldView(props);
    view.props.ref.current = { querySelector(selector) { return selector.includes("data-world-characters-trigger") ? characterTrigger : selector.includes("data-world-character=") ? card : trigger; } };
    const nodes = elements(view), quickFrame = nodes.find(element => element.props.id === "world-quick-menu");
    if (quickFrame) quickFrame.props.ref.current = new Element(`quick-${quickFrame.props["data-kind"]}`);
    return nodes;
  };
  const find = callback => render().find(callback);
  const component = name => find(element => typeof element.type === "function" && element.type.name === name);
  const restore = () => {
    if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument); else delete globalThis.document;
    if (savedElement) Object.defineProperty(globalThis, "HTMLElement", savedElement); else delete globalThis.HTMLElement;
  };
  return { find, component, render, focused, restore, props, get refreshes() { return refreshes; } };
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

test("a gift opens the pantry and returns to the same mounted reward dialog after refreshing capacity", () => {
  const nav = navigation();
  try {
    const original = nav.component("DailyRewardsDialog");
    nav.find(element => element.props["data-world-quick"] === "pantry").props.onClick();
    assert.equal(nav.component("WorldPantryMenu").props.onReturnToGift, undefined, "ordinary pantry visits have no gift return");
    nav.find(element => element.props["data-world-quick"] === "profile").props.onClick();
    const profile = nav.component("WorldProfileMenu");
    profile.props.rewards.props.triggerRef.current = { isConnected: true, focus() { nav.focused.push("hidden-gift-trigger"); } };
    profile.props.rewards.props.onRequestOpen();
    nav.component("DailyRewardsDialog").props.onOpenPantry();
    const closedGift = nav.component("DailyRewardsDialog"), pantry = nav.component("WorldPantryMenu");
    assert.equal(closedGift.props.open, false);
    assert.equal(closedGift.type, original.type); assert.equal(closedGift.key, original.key, "receipt resolution stays mounted");
    assert.equal(nav.component("WorldProfileMenu"), undefined);
    assert.equal(typeof pantry.props.onReturnToGift, "function");
    closedGift.props.onReturnFocus();
    assert.deepEqual(nav.focused, ["quick-pantry"], "focus follows the pantry instead of returning behind it");
    assert.equal(nav.refreshes, 0);
    pantry.props.onReturnToGift();
    const returnedGift = nav.component("DailyRewardsDialog");
    assert.equal(returnedGift.props.open, true);
    assert.equal(returnedGift.type, original.type); assert.equal(returnedGift.key, original.key);
    assert.equal(nav.component("WorldPantryMenu"), undefined);
    assert.equal(nav.refreshes, 1, "the claim uses refreshed economy capacity after selling or crafting");
    returnedGift.props.onOpenChange(false);
    nav.find(element => element.props["data-world-quick"] === "pantry").props.onClick();
    assert.equal(nav.component("WorldPantryMenu").props.onReturnToGift, undefined, "return is consumed when the gift is reopened");
  } finally { nav.restore(); }
});

test("another account never inherits a pantry return to the previous account's gift", () => {
  const nav = navigation();
  try {
    const gift = nav.component("DailyRewardsDialog");
    gift.props.onOpenChange(true);
    nav.component("DailyRewardsDialog").props.onOpenPantry();
    assert.equal(typeof nav.component("WorldPantryMenu").props.onReturnToGift, "function");
    nav.props.ownerPublicId = "another-player";
    assert.equal(nav.component("WorldPantryMenu").props.onReturnToGift, undefined);
    const otherGift = nav.component("DailyRewardsDialog");
    assert.equal(otherGift.key, "another-player"); assert.equal(otherGift.props.open, false);
    assert.equal(nav.refreshes, 0);
  } finally { nav.restore(); }
});

test("opening gifts from the profile clears an abandoned pantry return", () => {
  const nav = navigation();
  try {
    nav.component("DailyRewardsDialog").props.onOpenChange(true);
    nav.component("DailyRewardsDialog").props.onOpenPantry();
    assert.equal(typeof nav.component("WorldPantryMenu").props.onReturnToGift, "function");
    nav.find(element => element.props["aria-label"] === "Закрыть: Кладовая").props.onClick();
    assert.equal(nav.component("WorldPantryMenu"), undefined);
    nav.find(element => element.props["data-world-quick"] === "profile").props.onClick();
    nav.component("WorldProfileMenu").props.rewards.props.onRequestOpen();
    const gift = nav.component("DailyRewardsDialog"); assert.equal(gift.props.open, true);
    gift.props.onOpenChange(false);
    nav.find(element => element.props["data-world-quick"] === "pantry").props.onClick();
    assert.equal(nav.component("WorldPantryMenu").props.onReturnToGift, undefined);
    assert.equal(nav.refreshes, 0, "reopening from the profile does not follow the old pantry return");
  } finally { nav.restore(); }
});

test("a pantry material opens its exact recipe and a later map visit does not inherit that recipe", () => {
  const nav = navigation();
  const selection = place => ({ place, objectId: `${place}.position`, x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 });
  try {
    nav.find(element => element.props["data-world-quick"] === "pantry").props.onClick();
    nav.component("WorldPantryMenu").props.navigation.open("workshop", "make_planks");
    assert.equal(nav.component("WorldPantryMenu"), undefined, "the pantry yields its space to production");
    const scene = nav.component("WorldScene");
    assert.equal(scene.props.openObjectRequest.place, "workshop");
    scene.props.onPlace("workshop", selection("workshop"));
    const workshop = nav.component("WorldObjectMenu");
    assert.equal(workshop.props.initialStationId, "workshop");
    assert.equal(workshop.props.initialRecipeId, "make_planks");
    workshop.props.onClose();
    nav.component("WorldScene").props.onPlace("garden", selection("garden"));
    const garden = nav.component("WorldObjectMenu");
    assert.equal(garden.props.selection.place, "garden");
    assert.equal(garden.props.initialRecipeId, undefined);
    assert.equal(garden.props.initialStationId, undefined);
    assert.equal(nav.refreshes, 0, "opening a recipe does not issue an economy action or refresh");
  } finally { nav.restore(); }
});

test("map mine and legacy cave entries open cave travel without an anchored object menu", () => {
  for (const place of ["quarry", "cave"]) for (const anchored of [false, true]) {
    const nav = navigation();
    try {
      const object = anchored ? { place, objectId: `${place}.position`, x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 } : undefined;
      nav.component("WorldScene").props.onPlace(place, object);
      assert.equal(nav.component("WorldExpeditionsMenu").props.initialSector, "caves");
      assert.equal(nav.find(element => element.props.id === "world-quick-menu").props["data-kind"], "expeditions");
      assert.equal(nav.component("WorldObjectMenu"), undefined);
      assert.equal(nav.component("WorldScene").props.selectedObjectId, null);
      assert.equal(nav.component("WorldScene").props.openObjectRequest, undefined, "travel does not request a second map click");
      assert.equal(nav.component("WorldUpgradeDialog").props.stationId, null, "visiting the mine does not open its upgrade");
      assert.equal(nav.refreshes, 0);
    } finally { nav.restore(); }
  }
});

test("mine production markers, pantry links and upgrade requirements all lead directly to cave travel", () => {
  for (const source of ["production", "pantry", "requirement", "object"]) {
    const nav = navigation();
    try {
      if (source === "production") nav.component("WorldScene").props.onOpenProduction("quarry");
      else if (source === "pantry") {
        nav.find(element => element.props["data-world-quick"] === "pantry").props.onClick();
        nav.component("WorldPantryMenu").props.navigation.open("quarry");
      } else if (source === "requirement") {
        nav.component("WorldScene").props.onOpenConstruction("home");
        nav.component("WorldUpgradeDialog").props.navigation.open("quarry");
      } else {
        nav.component("WorldScene").props.onPlace("workshop", { place: "workshop", objectId: "workshop.position", x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 });
        nav.component("WorldObjectMenu").props.onNavigate("quarry", "quarry");
      }
      assert.equal(nav.component("WorldExpeditionsMenu").props.initialSector, "caves", source);
      assert.equal(nav.component("WorldPantryMenu"), undefined);
      assert.equal(nav.component("WorldObjectMenu"), undefined);
      assert.equal(nav.component("WorldUpgradeDialog").props.stationId, null);
      assert.equal(nav.component("WorldScene").props.openObjectRequest, undefined);
      assert.equal(nav.refreshes, 0);
    } finally { nav.restore(); }
  }
});

test("the separate mine upgrade returns to the same travel panel and its upgrade trigger", () => {
  const nav = navigation();
  try {
    nav.component("WorldScene").props.onPlace("quarry");
    const travel = nav.component("WorldExpeditionsMenu");
    document.activeElement = new HTMLElement("mine-upgrade");
    travel.props.onUpgradeQuarry();
    let upgrade = nav.component("WorldUpgradeDialog");
    assert.equal(upgrade.props.stationId, "quarry");
    assert.equal(nav.component("WorldExpeditionsMenu").key, travel.key, "opening the upgrade preserves the chosen route below it");
    assert.equal(nav.component("WorldObjectMenu"), undefined);
    upgrade.props.onClose();
    upgrade = nav.component("WorldUpgradeDialog");
    assert.equal(upgrade.props.stationId, null);
    const returned = nav.component("WorldExpeditionsMenu");
    assert.equal(returned.type, travel.type);
    assert.equal(returned.key, travel.key);
    assert.equal(returned.props.initialSector, "caves");
    upgrade.props.onCloseAutoFocus({ preventDefault() {} });
    assert.deepEqual(nav.focused, ["mine-upgrade"]);
    assert.equal(nav.refreshes, 0);
  } finally { nav.restore(); }
});

test("a repeated mine entry remounts travel in caves even when its previous initial sector was already caves", () => {
  const nav = navigation();
  try {
    nav.component("WorldScene").props.onPlace("quarry");
    const first = nav.component("WorldExpeditionsMenu");
    assert.equal(nav.component("WorldExpeditionsMenu").key, first.key, "ordinary rerenders preserve the panel's local sector and route");
    nav.component("WorldScene").props.onPlace("quarry");
    const reopened = nav.component("WorldExpeditionsMenu");
    assert.equal(reopened.props.initialSector, "caves");
    assert.notEqual(reopened.key, first.key, "a new mine entry resets any sector selected inside the previous panel");
    nav.component("WorldScene").props.onOpenProduction("quarry");
    const fromMarker = nav.component("WorldExpeditionsMenu");
    assert.equal(fromMarker.props.initialSector, "caves");
    assert.notEqual(fromMarker.key, reopened.key);
    assert.equal(nav.component("WorldObjectMenu"), undefined);
  } finally { nav.restore(); }
});

test("More, pantry and campfire open food without adding another permanent HUD button", () => {
  const text = element => Children.toArray(element.props.children).map(child => typeof child === "string" ? child : isValidElement(child) ? text(child) : "").join("");
  for (const source of ["more", "pantry", "campfire"]) {
    const nav = navigation();
    try {
      assert.equal(nav.find(element => element.props["data-world-quick"] === "food"), undefined);
      if (source === "more") {
        nav.find(element => element.props["data-world-quick"] === "more").props.onClick();
        nav.find(element => element.type === "button" && text(element).includes("Еда и заказы")).props.onClick();
      } else if (source === "pantry") {
        nav.find(element => element.props["data-world-quick"] === "pantry").props.onClick();
        nav.component("WorldPantryMenu").props.onOpenFood();
      } else {
        nav.component("WorldScene").props.onPlace("campfire", { place: "campfire", objectId: "campfire.position", x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 });
        nav.component("WorldObjectMenu").props.onOpenFood();
      }
      const food = nav.component("WorldFoodMenu");
      assert.ok(food); assert.equal(food.props.initialTab, "meals"); assert.equal(food.props.residentId, undefined);
      assert.equal(nav.component("WorldObjectMenu"), undefined);
      assert.equal(nav.component("WorldPantryMenu"), undefined);
      assert.equal(nav.find(element => element.props.id === "world-quick-menu").props["data-kind"], "food");
      nav.find(element => element.props["aria-label"] === "Закрыть: Еда и заказы").props.onClick();
      assert.equal(nav.component("WorldFoodMenu"), undefined);
      assert.deepEqual(nav.focused, ["more"]);
      assert.equal(nav.refreshes, 0);
    } finally { nav.restore(); }
  }
});

test("resident food actions select the intended tab and person, then recipes open on the campfire", () => {
  for (const [resident, action, tab] of [["plesk", "onOpenOrders", "orders"], ["builder", "onOpenOrders", "orders"], ["builder", "onOpenMeals", "meals"]]) {
    const nav = navigation();
    try {
      nav.component("WorldScene").props.onResident(resident);
      const dialogName = resident === "builder" ? "WorldBuilderDialog" : "WorldResidentDialog";
      nav.component(dialogName).props[action]();
      const food = nav.component("WorldFoodMenu");
      assert.equal(food.props.initialTab, tab); assert.equal(food.props.residentId, resident);
      assert.equal(nav.component(dialogName).props.open, false);
      assert.equal(nav.component("WorldCharacters").props.open, false);
      const beforeKey = food.key;
      assert.equal(nav.component("WorldFoodMenu").key, beforeKey, "ordinary snapshots preserve food selection");
      food.props.onNavigateStation("dryer", "cook_fish_soup");
      assert.equal(nav.component("WorldFoodMenu"), undefined);
      const scene = nav.component("WorldScene");
      assert.equal(scene.props.openObjectRequest.place, "campfire");
      scene.props.onPlace("campfire", { place: "campfire", objectId: "campfire.position", x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 });
      const campfire = nav.component("WorldObjectMenu");
      assert.equal(campfire.props.initialStationId, "dryer");
      assert.equal(campfire.props.initialRecipeId, "cook_fish_soup");
      campfire.props.onOpenFood();
      const reopened = nav.component("WorldFoodMenu");
      assert.notEqual(reopened.key, beforeKey, "explicit entry clears a previously selected resident/tab");
      assert.equal(reopened.props.initialTab, "meals"); assert.equal(reopened.props.residentId, undefined);
      assert.equal(nav.refreshes, 0, "these entries navigate without spending meals or redeeming orders");
    } finally { nav.restore(); }
  }
});

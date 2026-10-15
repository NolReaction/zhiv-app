import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
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
      let slots = [], cursor = 0, effectsEnabled = false, pending = new Map(), guideContext = {};
      export function reset() {
        for (const slot of slots) slot?.cleanup?.();
        slots = []; cursor = 0; effectsEnabled = false; pending.clear(); guideContext = {};
      }
      export function render() { cursor = 0; }
      export function captureEffects() { effectsEnabled = true; }
      export function flushEffects() {
        const effects = [...pending]; pending.clear();
        for (const [index, effect] of effects) {
          slots[index]?.cleanup?.(); slots[index].cleanup = effect();
        }
      }
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
      export function useEffect(effect, dependencies) {
        const index = cursor++;
        if (!effectsEnabled) return;
        const previous = slots[index];
        if (!previous || dependencies.some((value, position) => !Object.is(value, previous.dependencies?.[position]))) {
          slots[index] = { dependencies, cleanup: previous?.cleanup };
          pending.set(index, effect);
        }
      }
      export function useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); }
      export function setGuideContext(value) { guideContext = value; }
      // Character navigation tests keep the first-visit tutorial dismissed.
      export function useWorldOnboarding() {
        return { open: false, loaded: true, isPaused: false, progress: { version: 2, status: "skipped" },
          start() {}, step() {}, setCrop() {}, skip() {}, complete() {}, pause() {}, resume() {}, replay() {}, ...guideContext.onboarding };
      }
      export function useWorldRewardPromptGate() { return false; }
      export function useForestObservation() { return guideContext.observation ?? null; }
    `; },
    transform(source, id) {
      if (id.endsWith("/features/world/world-view.tsx") || id.endsWith("/features/world/world-portal.tsx") || id.endsWith("/features/economy/ui/construction/use-construction-goal.ts")) {
        return source.replace('from "react";', `from "${hookModule}";`)
          .replace('from "@/features/world/state/use-world-onboarding";', `from "${hookModule}";`)
          .replace('from "@/features/world/state/use-forest-observation";', `from "${hookModule}";`)
          .replace('from "@/features/world/state/onboarding-reward-gate";', `from "${hookModule}";`);
      }
    },
  }],
});
after(() => vite.close());
const { WORLD_CHARACTERS, worldCharacterResident } = await vite.ssrLoadModule("/features/world/characters/world-characters-model.ts");
const { WorldCharacters } = await vite.ssrLoadModule("/features/world/ui/characters/world-characters.tsx");
const { default: WorldView } = await vite.ssrLoadModule("/features/world/world-view.tsx");
const { default: WorldPortal } = await vite.ssrLoadModule("/features/world/world-portal.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
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
  const trigger = new Element("more"), characterTrigger = new Element("characters"), card = new Element("plesk"), map = new Element("map"), ordersTrigger = new Element("orders");
  Object.defineProperty(globalThis, "HTMLElement", { value: Element, configurable: true });
  Object.defineProperty(globalThis, "document", { value: { activeElement: map, querySelector: () => null, querySelectorAll: () => [] }, configurable: true });
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
    view.props.ref.current = { querySelector(selector) { return selector.includes("data-world-orders-entry") ? ordersTrigger : selector.includes("data-world-characters-trigger") ? characterTrigger : selector.includes("data-world-character=") ? card : trigger; } };
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
  return { find, component, render, focused, restore, props, ordersTrigger, createElement: name => new Element(name), get refreshes() { return refreshes; } };
}

function guideNavigation(context = {}) {
  const nav = navigation();
  nav.props.open = true;
  nav.props.economy.snapshot = {
    ownerPublicId: nav.props.ownerPublicId, revision: 1, catalog: economyCatalog,
    wallet: { coins: 1000, pearls: 0 }, inventory: {}, buildings: { home: 3, warehouse: 1, garden: 1, workshop: 1 }, jobs: [],
    storage: { used: 0, reserved: 0, capacity: 200, available: 200 },
  };
  hooks.setGuideContext(context);
  return nav;
}

test("wallet shortcuts replace the More shop entry and open the intended preview even while offline", () => {
  const nav = guideNavigation(); nav.props.isOnline = false;
  try {
    const wallet = nav.component("WorldWallet");
    assert.equal(typeof wallet.props.onOpenShop, "function");
    for (const [kind, initialPage] of [["coins", "gold"], ["pearls", "pearls"]]) {
      let focused = 0;
      const trigger = { isConnected: true, focus(options) { assert.equal(options.preventScroll, true); focused++; } };
      wallet.props.onOpenShop(kind, trigger);
      const panel = nav.component("CurrencyShopPanel");
      assert.equal(panel.props.initialPage, initialPage);
      assert.equal(panel.props.state, nav.props.economy.snapshot);
      const content = nav.find(node => node.props["data-shop"] === true);
      nav.find(node => node.props["aria-label"] === "Закрыть панель").props.onClick();
      assert.equal(nav.component("CurrencyShopPanel"), undefined);
      let prevented = false;
      content.props.onCloseAutoFocus({ preventDefault() { prevented = true; } });
      assert.equal(prevented, true); assert.equal(focused, 1, "close returns to the actual plus, including pointer users");
    }
    nav.find(node => node.props["data-world-quick"] === "more").props.onClick();
    const menu = nav.find(node => node.props.id === "world-quick-menu");
    const labels = elements(menu).filter(node => node.type === "button").map(node => renderToStaticMarkup(node)).join(" ");
    assert.doesNotMatch(labels, /Промокоды и витрина|>Магазин</);
    assert.match(labels, />Рынок</, "the player market remains in More");
    elements(menu).find(node => node.type === "button" && renderToStaticMarkup(node).includes(">Рынок<")).props.onClick();
    assert.equal(nav.component("EconomyPanel").props.initialTab, "market");
    assert.equal(nav.refreshes, 0, "opening preview never refreshes or issues an economic command");
  } finally { nav.restore(); }
});

test("wallet shop shortcuts reject a stale account snapshot and never restore focus to another owner", () => {
  const nav = guideNavigation();
  try {
    const openShop = nav.component("WorldWallet").props.onOpenShop;
    let oldFocus = 0;
    openShop("pearls", { isConnected: true, focus() { oldFocus++; } });
    nav.props.ownerPublicId = "different-owner";
    assert.equal(nav.component("WorldWallet").props.onOpenShop, undefined, "old snapshot is read-only during an account change");
    const content = nav.find(node => node.props["data-shop"] === true);
    content.props.onCloseAutoFocus({ preventDefault() {} });
    assert.equal(oldFocus, 0);
    nav.find(node => node.props["aria-label"] === "Закрыть панель").props.onClick();
    nav.props.economy.snapshot = { ...nav.props.economy.snapshot, ownerPublicId: "different-owner" };
    openShop("coins", { isConnected: true, focus() { oldFocus++; } });
    assert.equal(nav.component("CurrencyShopPanel"), undefined, "old callbacks cannot open the new owner's shop");
  } finally { nav.restore(); }
});

test("the orders lesson opens the real journal dock entry without blocking its own course", () => {
  const nav = guideNavigation({ onboarding: { progress: { version: 2, status: "started", stepId: "orders" } } });
  try {
    const guide = nav.component("WorldOnboardingSession").props;
    for (const key of ["onOpenOrders", "onOpenWorkshop", "onOpenGarden", "onOpenQuick", "onOpenResident", "onOpenHelp"]) {
      assert.equal(guide[key], undefined, `${key} must not let the coach bypass the real path`);
    }
    assert.equal(nav.component("WorldOrderJournal"), undefined);
    const entry = nav.find(element => element.props["data-world-orders-entry"] !== undefined);
    assert.equal(entry.type, "button"); assert.equal(entry.props["aria-haspopup"], "dialog");
    assert.equal(entry.props["aria-expanded"], false);
    entry.props.onClick({ currentTarget: nav.ordersTrigger });
    const journal = nav.component("WorldOrderJournal");
    assert.ok(journal); assert.equal(journal.props.residentId, undefined);
    const content = nav.find(element => element.props["data-orders"] === true);
    assert.equal(content.props.id, "world-order-journal");
    assert.equal(nav.component("WorldOnboardingSession").props.ordersElement, content.props.ref,
      "the coach targets the live portal content instead of the hidden map behind it");
    assert.equal(nav.component("WorldOnboardingSession").props.ordersOpen, true);
    assert.equal(nav.component("WorldOnboardingSession").props.modalBlocked, false, "the journal is the orders lesson's own surface");
    assert.equal(nav.component("SectionGuide").props.enabled, false, "the section introduction yields to the active initial course");
    assert.equal(nav.find(element => element.props.id === "world-quick-menu"), undefined);
    assert.equal(nav.refreshes, 0);
  } finally { nav.restore(); }
});

test("the workshop lesson requests only camera focus until a real map selection opens its menu", () => {
  const nav = guideNavigation({ onboarding: { progress: { version: 2, status: "started", stepId: "workshop" } } });
  try {
    let scene = nav.component("WorldScene");
    assert.equal(scene.props.guidePlace, "workshop");
    assert.equal(scene.props.openObjectRequest, undefined);
    assert.equal(nav.component("WorldObjectMenu"), undefined);
    assert.equal(nav.component("WorldOnboardingSession").props.workshopOpen, false);
    scene.props.onPlace("workshop", { place: "workshop", objectId: "workshop", x: 100, y: 150, viewportWidth: 390, viewportHeight: 700 });
    assert.equal(nav.component("WorldObjectMenu").props.selection.place, "workshop");
    assert.equal(nav.component("WorldOnboardingSession").props.workshopOpen, true);
    assert.equal(nav.component("WorldScene").props.guidePlace, null, "the map outline yields to the manually opened menu");
  } finally { nav.restore(); }
});

test("map guide focus respects pause and modal surfaces without requiring the retired workshop gift", () => {
  const nav = guideNavigation({ onboarding: { progress: { version: 2, status: "started", stepId: "workshop" } } });
  try {
    nav.props.economy.snapshot.buildings.workshop = 0;
    nav.props.economy.snapshot.workshopStarterClaimed = false;
    assert.equal(nav.component("WorldScene").props.guidePlace, "workshop", "an unbuilt workshop still has a safe map target");
    assert.equal(nav.component("WorldObjectMenu"), undefined, "the lesson does not open or build it automatically");
    nav.props.economy.snapshot.workshopStarterClaimed = true;
    assert.equal(nav.component("WorldScene").props.guidePlace, "workshop");
    hooks.setGuideContext({ onboarding: { progress: { version: 2, status: "started", stepId: "workshop" }, isPaused: true } });
    assert.equal(nav.component("WorldScene").props.guidePlace, null);
    hooks.setGuideContext({ onboarding: { progress: { version: 2, status: "started", stepId: "garden" } } });
    assert.equal(nav.component("WorldScene").props.guidePlace, "garden");
    nav.find(element => element.props["data-world-quick"] === "pantry").props.onClick();
    assert.equal(nav.component("WorldScene").props.guidePlace, null);
  } finally { nav.restore(); }
});

test("section introductions wait for loaded state and yield to the active initial course", () => {
  const started = { version: 2, status: "started", stepId: "pantry" };
  const cases = [
    { onboarding: { progress: { version: 2, status: "completed" } }, expected: true },
    { onboarding: { progress: { version: 2, status: "skipped" } }, expected: true },
    { onboarding: { progress: started }, expected: false },
    { onboarding: { progress: null }, expected: false },
    { onboarding: { loaded: false }, expected: false },
    { onboarding: { progress: started, isPaused: true }, expected: true },
  ];
  for (const { onboarding, expected } of cases) {
    const nav = guideNavigation({ onboarding });
    try {
      nav.find(element => element.props["data-world-quick"] === "pantry").props.onClick();
      const guide = nav.component("SectionGuide");
      assert.equal(guide.props.section, "pantry");
      assert.equal(guide.props.enabled, expected, JSON.stringify(onboarding));
      if (expected) assert.equal(nav.component("WorldOnboardingSession").props.modalBlocked, true,
        "the completed-course harvest reminder must not overlap a section lesson");
      nav.props.open = false;
      assert.equal(nav.component("SectionGuide"), undefined, "closing the map immediately ends the manual section session, including its exit animation");
      nav.props.open = true;
      nav.props.economy.snapshot = null;
      assert.equal(nav.component("SectionGuide").props.enabled, false, "wait for actual economy content");
    } finally { nav.restore(); }
  }
});

test("another device owning the forest suppresses quick and modal section introductions", () => {
  const nav = guideNavigation({ observation: { memory: { sync: { mode: "other-device" } } } });
  try {
    nav.find(element => element.props["data-world-quick"] === "pantry").props.onClick();
    assert.equal(nav.component("SectionGuide").props.enabled, false);
    nav.component("WorldPantryMenu").props.onOpenMarket();
    assert.equal(nav.component("SectionGuide").props.section, "market");
    assert.equal(nav.component("SectionGuide").props.enabled, false);
    nav.component("WorldScene").props.onResident("plesk");
    assert.equal(nav.component("WorldResidentDialog").props.guide.props.enabled, false);
    nav.component("WorldScene").props.onResident("builder");
    assert.equal(nav.component("WorldBuilderDialog").props.guide.props.enabled, false);
    hooks.setGuideContext({});
    assert.equal(nav.component("WorldBuilderDialog").props.guide.props.enabled, true,
      "returning ownership restores eligibility without consuming the introduction");
  } finally { nav.restore(); }
});

test("world exit immediately unmounts all seven manual guides even before the closing animation ends", () => {
  for (const section of ["pantry", "expeditions", "orders", "market", "workshop", "plesk", "builder"]) {
    const nav = guideNavigation();
    const guide = () => section === "plesk" ? nav.component("WorldResidentDialog").props.guide
      : section === "builder" ? nav.component("WorldBuilderDialog").props.guide
        : section === "workshop" ? nav.component("WorldObjectMenu").props.guide : nav.component("SectionGuide");
    try {
      if (section === "plesk" || section === "builder") nav.component("WorldScene").props.onResident(section);
      else if (section === "workshop") nav.component("WorldScene").props.onPlace("workshop",
        { place: "workshop", objectId: "workshop", x: 100, y: 150, viewportWidth: 390, viewportHeight: 700 });
      else if (section === "orders") nav.find(element => element.props["data-world-orders-entry"] !== undefined).props.onClick({ currentTarget: nav.ordersTrigger });
      else {
        nav.find(element => element.props["data-world-quick"] === (section === "market" ? "pantry" : section)).props.onClick();
        if (section === "market") nav.component("WorldPantryMenu").props.onOpenMarket();
      }
      assert.equal(guide().props.section, section);
      nav.props.open = false;
      assert.equal(guide(), undefined, section);
      nav.props.open = true;
      assert.equal(guide().props.section, section, "a quick re-entry mounts a fresh help controller");
      assert.equal(nav.refreshes, 0);
    } finally { nav.restore(); }
  }
});

test("the standalone journal has its own lesson and preserves filters through ordinary snapshots", () => {
  const nav = guideNavigation();
  try {
    nav.find(element => element.props["data-world-orders-entry"] !== undefined).props.onClick({ currentTarget: nav.ordersTrigger });
    const journal = nav.component("WorldOrderJournal"), key = journal.key;
    assert.equal(nav.component("SectionGuide").props.section, "orders");
    assert.equal(nav.component("SectionGuide").props.enabled, true);
    assert.equal(nav.component("WorldOnboardingSession").props.ordersOpen, true);
    assert.equal(nav.component("WorldOnboardingSession").props.modalBlocked, true);
    nav.props.economy.snapshot = { ...nav.props.economy.snapshot, revision: 2 };
    assert.equal(nav.component("WorldOrderJournal").key, key, "stock refreshes preserve the live journal's selection");
    nav.find(element => ["Закрыть панель", "Закрыть журнал заказов"].includes(element.props["aria-label"])).props.onClick();
    assert.equal(nav.component("WorldOrderJournal"), undefined);
    assert.equal(nav.component("WorldOnboardingSession").props.ordersOpen, false);
    assert.equal(nav.component("SectionGuide"), undefined);
  } finally { nav.restore(); }
});

test("foreground resident and market lessons temporarily replace an active initial course", () => {
  const nav = guideNavigation({ onboarding: { progress: { version: 2, status: "started", stepId: "neighbors" } } });
  try {
    assert.equal(nav.component("WorldOnboardingSession").props.modalBlocked, false);
    nav.find(element => element.props["data-world-quick"] === "pantry").props.onClick();
    assert.equal(nav.component("SectionGuide").props.enabled, false);
    nav.component("WorldPantryMenu").props.onOpenMarket();
    assert.equal(nav.component("WorldOnboardingSession").props.modalBlocked, true);
    assert.equal(nav.component("SectionGuide").props.section, "market");
    assert.equal(nav.component("SectionGuide").props.enabled, true);
    assert.equal(nav.component("WorldResidentDialog").props.guide.props.enabled, false);
    nav.find(element => ["Закрыть панель", "Закрыть журнал заказов"].includes(element.props["aria-label"])).props.onClick();
    assert.equal(nav.component("WorldOnboardingSession").props.modalBlocked, false);
    nav.component("WorldScene").props.onResident("plesk");
    assert.equal(nav.component("SectionGuide"), undefined, "market and quick lessons unmount behind the resident");
    assert.equal(nav.component("WorldOnboardingSession").props.modalBlocked, true);
    assert.equal(nav.component("WorldResidentDialog").props.guide.props.enabled, true);
    assert.equal(nav.component("WorldBuilderDialog").props.guide.props.enabled, false);
    nav.component("WorldResidentDialog").props.onClose();
    assert.equal(nav.component("WorldOnboardingSession").props.modalBlocked, false, "closing the section restores the initial course");
  } finally { nav.restore(); }
});

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

test("pointerdown on a guide control preserves the live quick menu while a map click still dismisses it", () => {
  for (const menu of ["profile", "pantry", "expeditions"]) {
    const nav = navigation();
    const names = ["Element", "window", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame"];
    const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const listeners = new Map();
    try {
      Object.defineProperty(globalThis, "Element", { value: HTMLElement, configurable: true });
      Object.defineProperty(globalThis, "window", { value: { addEventListener() {}, removeEventListener() {} }, configurable: true });
      Object.defineProperty(globalThis, "ResizeObserver", { value: class { observe() {} disconnect() {} }, configurable: true });
      Object.defineProperty(globalThis, "requestAnimationFrame", { value: callback => { callback(); return 1; }, configurable: true });
      Object.defineProperty(globalThis, "cancelAnimationFrame", { value() {}, configurable: true });
      document.addEventListener = (type, callback) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(callback);
      };
      document.removeEventListener = (type, callback) => listeners.get(type)?.delete(callback);
      hooks.captureEffects();
      const render = () => {
        const nodes = nav.render();
        const frame = nodes.find(element => element.props.id === "world-quick-menu");
        if (frame) frame.props.ref.current.contains = target => target === frame.props.ref.current;
        hooks.flushEffects();
        return nodes;
      };
      nav.find(element => element.props["data-world-quick"] === menu).props.onClick();
      assert.equal(render().find(element => element.props.id === "world-quick-menu").props["data-kind"], menu);
      const guideButton = new HTMLElement("guide-next"), outsideMap = new HTMLElement("outside-map");
      guideButton.closest = selector => selector.split(",").map(part => part.trim()).includes('[data-guide-coach="world"]') ? {} : null;
      outsideMap.closest = () => null;
      const pointerDown = target => { for (const listener of [...(listeners.get("pointerdown") ?? [])]) listener({ target }); };
      assert.equal(listeners.get("pointerdown")?.size, 1, "the actual WorldView effect registers the outside-click handler");
      pointerDown(guideButton);
      assert.equal(render().find(element => element.props.id === "world-quick-menu").props["data-kind"], menu,
        "a phone's pointerdown must not dismiss the live section before its coach control receives click");
      pointerDown(outsideMap);
      assert.equal(render().find(element => element.props.id === "world-quick-menu"), undefined,
        "the guide exemption must preserve ordinary outside-click dismissal");
    } finally {
      hooks.reset();
      nav.restore();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
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

const quarrySelection = () => ({ place: "quarry", objectId: "quarry.position", x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 });

function completeMineRequest(nav) {
  const scene = nav.component("WorldScene");
  assert.equal(scene.props.openObjectRequest.place, "quarry", "navigation requests the actual quarry map object");
  assert.equal(nav.component("WorldExpeditionsMenu"), undefined, "the mine is absent from the general travel window");
  assert.equal(nav.component("WorldObjectMenu"), undefined, "the scene supplies real anchor coordinates before opening a menu");
  const selection = quarrySelection();
  scene.props.onPlace("quarry", selection);
  const mine = nav.component("WorldObjectMenu");
  assert.equal(mine.props.selection, selection, "the quarry menu uses the scene's real selection");
  assert.equal(mine.props.initialStationId, "quarry");
  assert.equal(nav.component("WorldScene").props.selectedObjectId, selection.objectId);
  assert.equal(nav.component("WorldUpgradeDialog").props.stationId, null, "visiting the mine does not open its upgrade");
  return mine;
}

test("map quarry opens its anchored mine while legacy cave entries request the real quarry", () => {
  for (const place of ["quarry", "cave"]) for (const anchored of [false, true]) {
    const nav = navigation();
    try {
      const selection = anchored ? { ...quarrySelection(), place, objectId: `${place}.position` } : undefined;
      nav.component("WorldScene").props.onPlace(place, selection);
      if (place === "quarry" && anchored) {
        const mine = nav.component("WorldObjectMenu");
        assert.equal(mine.props.selection, selection);
        assert.equal(nav.component("WorldScene").props.openObjectRequest, undefined, "a real quarry click needs no second activation");
        assert.equal(nav.component("WorldScene").props.selectedObjectId, selection.objectId);
        assert.equal(nav.component("WorldUpgradeDialog").props.stationId, null);
      } else completeMineRequest(nav);
      assert.equal(nav.component("WorldExpeditionsMenu"), undefined);
      assert.equal(nav.find(element => element.props.id === "world-quick-menu"), undefined);
      assert.equal(nav.refreshes, 0);
    } finally { nav.restore(); }
  }
});

test("mine production markers, pantry links and upgrade requirements lead to the dedicated quarry object", () => {
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
        nav.component("WorldScene").props.onPlace("workshop", { ...quarrySelection(), place: "workshop", objectId: "workshop.position" });
        nav.component("WorldObjectMenu").props.onNavigate("quarry", "quarry");
      }
      const mine = completeMineRequest(nav);
      assert.equal(nav.component("WorldPantryMenu"), undefined, source);
      assert.equal(nav.component("WorldUpgradeDialog").props.stationId, null, source);
      if (source === "requirement") nav.component("WorldUpgradeDialog").props.onCloseAutoFocus({ preventDefault() {} });
      mine.props.onClose();
      assert.equal(nav.component("WorldObjectMenu"), undefined);
      assert.deepEqual(nav.focused, [source === "pantry" ? "more" : "map"], "closing the mine restores its source trigger");
      assert.equal(nav.refreshes, 0);
    } finally { nav.restore(); }
  }
});

test("a repeated mine entry resets its local route while camera anchor updates preserve the menu", () => {
  const nav = navigation();
  try {
    const firstSelection = quarrySelection();
    nav.component("WorldScene").props.onPlace("quarry", firstSelection);
    const first = nav.component("WorldObjectMenu");
    assert.equal(nav.component("WorldObjectMenu").key, first.key, "ordinary rerenders preserve mine preparation");
    const moved = { ...firstSelection, x: 200, y: 385 };
    nav.component("WorldScene").props.onObjectSelection(moved);
    assert.equal(nav.component("WorldObjectMenu").key, first.key, "moving the camera does not reset the mine's selected route");
    assert.equal(nav.component("WorldObjectMenu").props.selection, moved);
    nav.component("WorldScene").props.onPlace("quarry", moved);
    const reopened = nav.component("WorldObjectMenu");
    assert.notEqual(reopened.key, first.key, "an explicit mine entry opens a fresh preparation view");
    nav.component("WorldScene").props.onOpenProduction("quarry");
    const fromMarker = completeMineRequest(nav);
    assert.notEqual(fromMarker.key, reopened.key);
    assert.equal(nav.component("WorldExpeditionsMenu"), undefined);
    assert.equal(nav.refreshes, 0);
  } finally { nav.restore(); }
});

test("journal and legacy cave help links open the dedicated mine and preserve source focus", () => {
  for (const source of ["orders", "help"]) {
    const nav = navigation();
    try {
      if (source === "orders") {
        document.activeElement = nav.ordersTrigger;
        nav.find(element => element.props["data-world-orders-entry"] !== undefined).props.onClick({ currentTarget: nav.ordersTrigger });
        nav.component("WorldOrderJournal").props.onNavigateExpeditions("caves");
        assert.equal(nav.component("WorldOrderJournal"), undefined);
      } else {
        nav.find(element => element.props["data-world-quick"] === "more").props.onClick();
        nav.find(element => element.props["aria-label"] === "Справка по игре").props.onClick();
        nav.component("WorldHelp").props.onNavigate({ kind: "expeditions", sector: "caves" });
        assert.equal(nav.component("WorldHelp"), undefined);
      }
      const mine = completeMineRequest(nav);
      mine.props.onClose();
      assert.deepEqual(nav.focused, [source === "orders" ? "orders" : "more"]);
      assert.equal(nav.refreshes, 0);
    } finally { nav.restore(); }
  }
});

test("an explicit mine notification activates quarry once while generic or foreign notices keep their own routing", () => {
  for (const target of ["mine", "activities", "foreign-mine"]) {
    const nav = guideNavigation();
    const names = ["window", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame"];
    const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const timers = new Map(), handled = [];
    try {
      let timerId = 0;
      Object.defineProperty(globalThis, "window", { value: {
        addEventListener() {}, removeEventListener() {},
        setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
        clearTimeout(id) { timers.delete(id); },
      }, configurable: true });
      Object.defineProperty(globalThis, "ResizeObserver", { value: class { observe() {} disconnect() {} }, configurable: true });
      Object.defineProperty(globalThis, "requestAnimationFrame", { value: callback => { callback(); return 1; }, configurable: true });
      Object.defineProperty(globalThis, "cancelAnimationFrame", { value() {}, configurable: true });
      document.addEventListener = () => {}; document.removeEventListener = () => {};
      nav.props.sceneReady = true;
      nav.props.notificationEntry = { ownerPublicId: target === "foreign-mine" ? "other-owner" : nav.props.ownerPublicId, request: 1, target: target === "foreign-mine" ? "mine" : target };
      nav.props.onNotificationHandled = request => handled.push(request);
      hooks.captureEffects(); nav.render(); hooks.flushEffects();
      for (const callback of [...timers.values()]) callback();
      if (target === "mine") completeMineRequest(nav);
      else if (target === "activities") {
        assert.equal(nav.component("WorldExpeditionsMenu").props.initialSector, "forest");
        assert.equal(nav.component("WorldScene").props.openObjectRequest, undefined);
      } else {
        assert.equal(nav.component("WorldExpeditionsMenu"), undefined);
        assert.equal(nav.component("WorldScene").props.openObjectRequest, undefined);
      }
      assert.deepEqual(handled, target === "foreign-mine" ? [] : [1]);
      timers.clear(); nav.render(); hooks.flushEffects();
      assert.equal(timers.size, 0, "the same notification request never activates a second object");
      assert.equal(nav.refreshes, 0, "notifications only navigate and never claim rewards");
    } finally {
      hooks.reset(); nav.restore();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  }
});

test("the four dock entries include a standalone journal while food stays in its action context", () => {
  const nav = navigation();
  try {
    const dock = nav.find(element => element.type === "nav" && element.props["aria-label"] === "Действия в игре");
    const entries = elements(dock).filter(element => element.type === "button");
    assert.equal(entries.length, 4);
    assert.ok(entries.some(element => element.props["data-world-orders-entry"] !== undefined));
    nav.find(element => element.props["data-world-quick"] === "more").props.onClick();
    const menu = nav.find(element => element.props.id === "world-quick-menu");
    const labels = elements(menu).filter(element => element.type === "button").map(element => renderToStaticMarkup(element)).join(" ");
    assert.doesNotMatch(labels, /Еда и заказы|data-world-food-entry/);
    nav.find(element => element.props["data-world-quick"] === "pantry").props.onClick();
    assert.equal(nav.component("WorldPantryMenu").props.onOpenFood, undefined);
    nav.component("WorldScene").props.onPlace("campfire", { place: "campfire", objectId: "campfire.position", x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 });
    assert.equal(nav.component("WorldObjectMenu").props.onOpenFood, undefined);
    assert.equal(nav.component("WorldFoodMenu"), undefined);
    assert.equal(nav.refreshes, 0);
  } finally { nav.restore(); }
});

test("resident orders open the journal with the intended customer and exact recipe links preserve navigation", () => {
  for (const resident of ["plesk", "builder"]) {
    const nav = navigation();
    try {
      nav.component("WorldScene").props.onResident(resident);
      const dialogName = resident === "builder" ? "WorldBuilderDialog" : "WorldResidentDialog";
      nav.component(dialogName).props.onOpenOrders();
      const journal = nav.component("WorldOrderJournal");
      assert.equal(journal.props.residentId, resident);
      assert.equal(nav.component(dialogName).props.open, false);
      assert.equal(nav.component("WorldCharacters").props.open, false);
      const beforeKey = journal.key;
      assert.equal(nav.component("WorldOrderJournal").key, beforeKey);
      journal.props.onNavigateStation("dryer", "cook_fish_soup");
      assert.equal(nav.component("WorldOrderJournal"), undefined);
      const scene = nav.component("WorldScene");
      assert.equal(scene.props.openObjectRequest.place, "campfire");
      scene.props.onPlace("campfire", { place: "campfire", objectId: "campfire.position", x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 });
      const campfire = nav.component("WorldObjectMenu");
      assert.equal(campfire.props.initialStationId, "dryer");
      assert.equal(campfire.props.initialRecipeId, "cook_fish_soup");
      nav.find(element => element.props["data-world-orders-entry"] !== undefined).props.onClick({ currentTarget: nav.ordersTrigger });
      const reopened = nav.component("WorldOrderJournal");
      assert.notEqual(reopened.key, beforeKey, "a new dock visit resets the previous customer filter");
      assert.equal(reopened.props.residentId, undefined);
      assert.equal(nav.refreshes, 0, "navigation never consumes food or completes an order");
    } finally { nav.restore(); }
  }
});


test("the journal opens from a native dock button and modal close restores its actual source or connected dock fallback", () => {
  for (const exit of ["close", "modal"]) for (const connected of [true, false]) {
    const nav = navigation();
    try {
      const source = nav.createElement("journal-source");
      document.activeElement = source;
      const entry = nav.find(element => element.props["data-world-orders-entry"] !== undefined);
      assert.equal(entry.type, "button"); assert.notEqual(entry.props.tabIndex, -1);
      assert.equal(entry.props["aria-expanded"], false);
      entry.props.onClick({ currentTarget: source });
      const expanded = nav.find(element => element.props["data-world-orders-entry"] !== undefined);
      assert.equal(expanded.props["aria-expanded"], true); assert.equal(expanded.props["aria-controls"], "world-order-journal");
      const content = nav.find(element => element.props["data-orders"] === true);
      assert.equal(content.props.id, "world-order-journal");
      source.isConnected = connected;
      if (exit === "close") nav.find(element => ["Закрыть панель", "Закрыть журнал заказов"].includes(element.props["aria-label"])).props.onClick();
      else nav.find(element => element.props.open === true && typeof element.props.onOpenChange === "function").props.onOpenChange(false);
      assert.equal(nav.component("WorldOrderJournal"), undefined);
      let prevented = false;
      content.props.onCloseAutoFocus({ preventDefault() { prevented = true; } });
      assert.equal(prevented, true);
      assert.deepEqual(nav.focused, [connected ? "journal-source" : "orders"]);
      assert.equal(nav.refreshes, 0);
    } finally { nav.restore(); }
  }
});

test("journal focus never returns to a previous owner's trigger and other initial lessons remain blocked behind it", () => {
  const nav = guideNavigation({ onboarding: { progress: { version: 2, status: "started", stepId: "workshop" } } });
  try {
    document.activeElement = nav.ordersTrigger;
    nav.find(element => element.props["data-world-orders-entry"] !== undefined).props.onClick({ currentTarget: nav.ordersTrigger });
    assert.equal(nav.component("WorldOnboardingSession").props.ordersOpen, true);
    assert.equal(nav.component("WorldOnboardingSession").props.modalBlocked, true, "only the orders step may use this modal as its own surface");
    nav.props.ownerPublicId = "another-player";
    const content = nav.find(element => element.props["data-orders"] === true);
    nav.find(element => ["Закрыть панель", "Закрыть журнал заказов"].includes(element.props["aria-label"])).props.onClick();
    content.props.onCloseAutoFocus({ preventDefault() {} });
    assert.deepEqual(nav.focused, []);
    assert.equal(nav.refreshes, 0);
  } finally { nav.restore(); }
});

test("canonical order help and legacy food-order help open the same customer-filtered journal", () => {
  for (const target of [{ kind: "orders" }, { kind: "orders", residentId: "builder" }, { kind: "food", tab: "orders", residentId: "plesk" }]) {
    const nav = navigation();
    try {
      nav.find(element => element.props["data-world-quick"] === "more").props.onClick();
      nav.find(element => element.props["aria-label"] === "Справка по игре").props.onClick();
      nav.component("WorldHelp").props.onNavigate(target);
      assert.equal(nav.component("WorldHelp"), undefined);
      assert.equal(nav.component("WorldOrderJournal").props.residentId, target.residentId);
      assert.equal(nav.component("WorldFoodMenu"), undefined);
      assert.equal(nav.find(element => element.props.id === "world-quick-menu"), undefined);
      assert.equal(nav.refreshes, 0);
    } finally { nav.restore(); }
  }
});

test("legacy meal help goes to actual expedition or builder food controls without restoring the old combined menu", () => {
  for (const residentId of [undefined, "builder"]) {
    const nav = navigation();
    try {
      nav.find(element => element.props["data-world-quick"] === "more").props.onClick();
      nav.find(element => element.props["aria-label"] === "Справка по игре").props.onClick();
      nav.component("WorldHelp").props.onNavigate({ kind: "food", tab: "meals", residentId });
      assert.equal(nav.component("WorldHelp"), undefined);
      assert.equal(nav.component("WorldFoodMenu"), undefined);
      assert.equal(nav.component("WorldOrderJournal"), undefined);
      if (residentId === "builder") assert.equal(nav.component("WorldBuilderDialog").props.open, true);
      else assert.ok(nav.component("WorldExpeditionsMenu"));
      assert.equal(nav.refreshes, 0);
    } finally { nav.restore(); }
  }
});


test("closing a customer journal returns to the dock when the resident's source button has unmounted", () => {
  for (const resident of ["builder", "plesk"]) {
    const nav = navigation();
    try {
      nav.component("WorldScene").props.onResident(resident);
      const source = nav.createElement(`${resident}-orders`);
      document.activeElement = source;
      nav.component(resident === "builder" ? "WorldBuilderDialog" : "WorldResidentDialog").props.onOpenOrders();
      const content = nav.find(element => element.props["data-orders"] === true);
      source.isConnected = false;
      nav.find(element => ["Закрыть панель", "Закрыть журнал заказов"].includes(element.props["aria-label"])).props.onClick();
      content.props.onCloseAutoFocus({ preventDefault() {} });
      assert.deepEqual(nav.focused, ["orders"]);
      assert.equal(nav.component("WorldCharacters").props.open, false);
      assert.equal(nav.refreshes, 0);
    } finally { nav.restore(); }
  }
});

function pantryHeaderUpgrade(nav) {
  const menu = nav.find(element => element.props.id === "world-quick-menu");
  const header = elements(menu).find(element => element.type === "header");
  const control = elements(header).find(element => typeof element.type === "function" && element.type.name === "WorldPantryUpgrade");
  return { header, button: control ? control.type(control.props) : null };
}

function pointerNavigation() {
  const nav = guideNavigation();
  const names = ["Element", "window", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame"];
  const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const listeners = new Map();
  Object.defineProperty(globalThis, "Element", { value: HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "window", { value: { addEventListener() {}, removeEventListener() {} }, configurable: true });
  Object.defineProperty(globalThis, "ResizeObserver", { value: class { observe() {} disconnect() {} }, configurable: true });
  Object.defineProperty(globalThis, "requestAnimationFrame", { value: callback => { callback(); return 1; }, configurable: true });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { value() {}, configurable: true });
  document.addEventListener = (type, callback) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(callback);
  };
  document.removeEventListener = (type, callback) => listeners.get(type)?.delete(callback);
  hooks.captureEffects();
  const render = () => {
    const nodes = nav.render();
    const frame = nodes.find(element => element.props.id === "world-quick-menu");
    if (frame) frame.props.ref.current.contains = target => target.quickMenu === frame.props["data-kind"];
    hooks.flushEffects();
    return nodes;
  };
  return { nav, render,
    pointerDown(target) { for (const listener of [...(listeners.get("pointerdown") ?? [])]) listener({ target }); },
    restore() {
      hooks.reset(); nav.restore();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
      }
    },
  };
}

function pantryPopupTarget(nav, owner = nav.props.ownerPublicId) {
  const popup = nav.createElement("fish-sale-popup"), child = nav.createElement("fish-sale-control");
  popup.dataset.pantryFishOwner = owner;
  popup.getAttribute = name => name === "data-pantry-fish-owner" ? owner : null;
  child.closest = selector => selector.split(",").some(part => part.trim() === "[data-pantry-fish-popover]") ? popup : null;
  return child;
}

test("the pantry header offers expansion and its paid progress while maximum or foreign storage has no upgrade action", () => {
  const maximum = Math.max(...economyCatalog.buildings.find(building => building.id === "warehouse").levels.map(level => level.level));
  for (const scenario of ["next", "running", "ready", "maximum", "foreign", "loading"]) {
    const nav = guideNavigation();
    try {
      const now = nav.props.economy.now;
      if (scenario === "maximum") nav.props.economy.snapshot.buildings.warehouse = maximum;
      if (scenario === "foreign") nav.props.economy.snapshot.ownerPublicId = "previous-owner";
      if (scenario === "loading") nav.props.economy.snapshot = null;
      if (scenario === "running" || scenario === "ready") nav.props.economy.snapshot.jobs = [{
        id: "b804170f-fb93-4320-bf76-972e3693bba0", kind: "construction", targetId: "warehouse", recipeId: null, targetLevel: 2,
        startedAt: new Date(now - 300_000).toISOString(), finishesAt: new Date(now + (scenario === "ready" ? -1000 : 300_000)).toISOString(), rewards: {},
      }];
      nav.find(element => element.props["data-world-quick"] === "pantry").props.onClick();
      const { header, button } = pantryHeaderUpgrade(nav);
      if (["maximum", "foreign", "loading"].includes(scenario)) assert.equal(button, null, scenario);
      else {
        assert.ok(header); assert.equal(button.type, "button");
        assert.notEqual(button.props["data-guide-pantry-upgrade"], undefined);
        assert.equal(button.props["aria-haspopup"], "dialog");
        const html = renderToStaticMarkup(button);
        assert.match(html, scenario === "running" ? /Стройка/ : scenario === "ready" ? /Готово/ : /Улучшить/);
      }
      assert.equal(nav.component("WorldPantryMenu").props.onUpgrade, undefined, "the pantry content cannot retain the old footer expansion action");
      assert.equal(nav.refreshes, 0);
    } finally { nav.restore(); }
  }
});

test("the header expansion opens the existing warehouse dialog and returns focus without closing or mutating the pantry", () => {
  const nav = guideNavigation();
  try {
    nav.find(element => element.props["data-world-quick"] === "pantry").props.onClick();
    const source = nav.createElement("pantry-header-upgrade");
    document.activeElement = source;
    pantryHeaderUpgrade(nav).button.props.onClick({ currentTarget: source });
    let dialog = nav.component("WorldUpgradeDialog");
    assert.equal(dialog.props.stationId, "warehouse");
    assert.ok(nav.component("WorldPantryMenu"), "requirements open above the same stock view");
    dialog.props.onClose();
    dialog = nav.component("WorldUpgradeDialog");
    assert.equal(dialog.props.stationId, null);
    dialog.props.onCloseAutoFocus({ preventDefault() {} });
    assert.deepEqual(nav.focused, ["pantry-header-upgrade"]);
    assert.ok(nav.component("WorldPantryMenu"));
    assert.equal(nav.refreshes, 0);
  } finally { nav.restore(); }
});

test("warehouse dialog focus cannot return to a previous owner's header button", () => {
  const nav = guideNavigation();
  try {
    nav.find(element => element.props["data-world-quick"] === "pantry").props.onClick();
    const source = nav.createElement("old-pantry-header");
    document.activeElement = source;
    pantryHeaderUpgrade(nav).button.props.onClick({ currentTarget: source });
    nav.props.ownerPublicId = "new-owner";
    nav.props.economy.snapshot = { ...nav.props.economy.snapshot, ownerPublicId: "new-owner" };
    nav.component("WorldUpgradeDialog").props.onClose();
    nav.component("WorldUpgradeDialog").props.onCloseAutoFocus({ preventDefault() {} });
    assert.deepEqual(nav.focused, []);
    assert.equal(nav.refreshes, 0);
  } finally { nav.restore(); }
});

test("owned fish sale controls and switching fish preserve the pantry until a genuine outside pointerdown", () => {
  const pointer = pointerNavigation(), { nav } = pointer;
  try {
    nav.find(element => element.props["data-world-quick"] === "pantry").props.onClick();
    pointer.render();
    const popupControl = pantryPopupTarget(nav);
    pointer.pointerDown(popupControl);
    assert.equal(pointer.render().find(element => element.props.id === "world-quick-menu").props["data-kind"], "pantry");
    const anotherFish = nav.createElement("another-fish-card");
    anotherFish.quickMenu = "pantry"; anotherFish.closest = () => null;
    pointer.pointerDown(anotherFish);
    assert.ok(pointer.render().find(element => element.props.id === "world-quick-menu"), "the new card gets its click before the pantry can unmount");
    const outside = nav.createElement("outside-map"); outside.closest = () => null;
    pointer.pointerDown(outside);
    assert.equal(pointer.render().find(element => element.props.id === "world-quick-menu"), undefined);
    assert.equal(nav.refreshes, 0);
  } finally { pointer.restore(); }
});

test("a foreign fish popup and fish controls beside other quick menus receive no pantry outside-click exemption", () => {
  for (const [menu, foreign] of [["pantry", true], ["profile", false], ["expeditions", false], ["more", false]]) {
    const pointer = pointerNavigation(), { nav } = pointer;
    try {
      nav.find(element => element.props["data-world-quick"] === menu).props.onClick();
      pointer.render();
      pointer.pointerDown(pantryPopupTarget(nav, foreign ? "previous-owner" : nav.props.ownerPublicId));
      assert.equal(pointer.render().find(element => element.props.id === "world-quick-menu"), undefined, `${menu}: no blanket popup exemption`);
      assert.equal(nav.refreshes, 0);
    } finally { pointer.restore(); }
  }
});

test("the pantry introduction yields to its fish sale and returns when the sale closes", () => {
  const nav = guideNavigation();
  try {
    nav.find(element => element.props["data-world-quick"] === "pantry").props.onClick();
    assert.equal(nav.component("SectionGuide").props.enabled, true);
    nav.component("WorldPantryMenu").props.onFishSaleOpenChange(true);
    assert.equal(nav.component("SectionGuide").props.enabled, false, "the nonmodal sale stays usable without a coach covering it");
    nav.component("WorldPantryMenu").props.onFishSaleOpenChange(false);
    assert.equal(nav.component("SectionGuide").props.enabled, true);
    assert.equal(nav.refreshes, 0);
  } finally { nav.restore(); }
});

test("Escape closes only the owned fish sale before the pantry and never intercepts foreign or unrelated popups", () => {
  for (const scenario of ["owned", "foreign", "other-menu", "changed-owner"]) {
    const pointer = pointerNavigation(), { nav } = pointer;
    try {
      nav.props.escapeHandlerRef = { current: null };
      const originalOwner = nav.props.ownerPublicId;
      nav.find(element => element.props["data-world-quick"] === (scenario === "other-menu" ? "profile" : "pantry")).props.onClick();
      pointer.render();
      const popup = nav.createElement("fish-sale-popup"), close = nav.createElement("fish-sale-close");
      popup.dataset.pantryFishOwner = scenario === "foreign" ? "previous-owner" : originalOwner;
      popup.querySelector = selector => selector.includes("data-pantry-fish-close") ? close : null;
      close.closest = selector => selector.includes("data-pantry-fish-popover") ? popup : null;
      let closed = 0, popupOpen = true;
      close.click = () => { closed++; popupOpen = false; };
      document.activeElement.closest = () => null;
      document.querySelector = selector => popupOpen && selector.includes("data-pantry-fish-close") ? close : popupOpen && selector === "[data-pantry-fish-popover]" ? popup : null;
      document.querySelectorAll = selector => popupOpen && selector.includes("data-pantry-fish-close") ? [close] : [];
      if (scenario === "changed-owner") {
        nav.props.ownerPublicId = "new-owner";
        nav.props.economy.snapshot = { ...nav.props.economy.snapshot, ownerPublicId: "new-owner" };
        pointer.render();
      }
      assert.equal(typeof nav.props.escapeHandlerRef.current, "function");
      assert.equal(nav.props.escapeHandlerRef.current(), true);
      assert.equal(closed, scenario === "owned" ? 1 : 0, scenario);
      const menu = pointer.render().find(element => element.props.id === "world-quick-menu");
      if (scenario === "owned") {
        assert.equal(menu.props["data-kind"], "pantry", "the first Escape leaves the refrigerator visible");
        assert.equal(nav.props.escapeHandlerRef.current(), true);
        assert.equal(pointer.render().find(element => element.props.id === "world-quick-menu"), undefined, "the next Escape closes the pantry normally");
      } else assert.equal(menu, undefined, "foreign controls do not replace normal quick-menu Escape");
      assert.equal(nav.refreshes, 0);
    } finally { pointer.restore(); }
  }
});

test("network changes and a temporary activity suspension preserve the same pantry or selected production menu", () => {
  for (const surface of ["pantry", "workshop"]) {
    const nav = guideNavigation();
    try {
      const selection = { place: "workshop", objectId: "workshop.position", x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 };
      if (surface === "pantry") nav.find(node => node.props["data-world-quick"] === "pantry").props.onClick();
      else nav.component("WorldScene").props.onPlace("workshop", selection);
      const menuName = surface === "pantry" ? "WorldPantryMenu" : "WorldObjectMenu", original = nav.component(menuName);
      assert.ok(original); assert.equal(nav.component("WorldScene").props.suspended, false);
      for (const [online, suspended] of [[false, false], [false, true], [true, true], [true, false]]) {
        nav.props.isOnline = online; nav.props.suspended = suspended;
        const retained = nav.component(menuName);
        assert.ok(retained, `${surface}: a transport or pause update cannot discard the active menu`);
        assert.equal(retained.type, original.type); assert.equal(retained.key, original.key);
        assert.equal(nav.component("WorldScene").props.suspended, suspended);
        assert.equal(nav.props.open, true, "pausing the scene does not close its world dialog");
        if (surface === "workshop") {
          assert.equal(retained.props.selection, selection);
          assert.equal(nav.component("WorldScene").props.selectedObjectId, selection.objectId);
        }
      }
      assert.equal(nav.refreshes, 0, "a retained navigation surface cannot mutate or refresh economy");
    } finally { nav.restore(); }
  }
});

test("the activity gate owns Escape and pointer input without closing the retained pantry", () => {
  const pointer = pointerNavigation(), { nav } = pointer;
  try {
    nav.props.escapeHandlerRef = { current: null };
    nav.find(node => node.props["data-world-quick"] === "pantry").props.onClick();
    let gateOpen = false;
    document.querySelector = selector => gateOpen && selector === "[data-activity-gate]" ? {} : null;
    document.querySelectorAll = () => [];
    document.activeElement.closest = () => null;
    pointer.render();
    gateOpen = true; nav.props.suspended = true; pointer.render();
    assert.equal(nav.props.escapeHandlerRef.current(), true);
    const resume = nav.createElement("activity-resume"); resume.closest = selector => selector.includes("data-activity-gate") ? {} : null;
    pointer.pointerDown(resume);
    const retained = pointer.render().find(node => node.props.id === "world-quick-menu");
    assert.equal(retained?.props["data-kind"], "pantry", "the resume button receives its click without dismissing the pantry underneath");
    assert.equal(nav.component("WorldScene").props.suspended, true);
    gateOpen = false; nav.props.suspended = false; pointer.render();
    const map = nav.createElement("map-after-resume"); map.closest = () => null;
    pointer.pointerDown(map);
    assert.equal(pointer.render().find(node => node.props.id === "world-quick-menu"), undefined, "ordinary outside dismissal resumes after the gate closes");
    assert.equal(nav.refreshes, 0);
  } finally { pointer.restore(); }
});

test("connection indicator and detail controls preserve each live quick menu while real outside clicks still close it", () => {
  for (const menu of ["pantry", "profile", "expeditions"]) {
    const pointer = pointerNavigation(), { nav } = pointer;
    try {
      nav.find(node => node.props["data-world-quick"] === menu).props.onClick(); pointer.render();
      for (const marker of ["[data-connection-status]", "[data-connection-details]"]) {
        const control = nav.createElement("connection-control");
        control.closest = selector => selector.split(",").some(part => part.trim() === marker) ? {} : null;
        pointer.pointerDown(control);
        assert.equal(pointer.render().find(node => node.props.id === "world-quick-menu")?.props["data-kind"], menu,
          "checking transport status cannot discard the live inventory or preparation surface");
      }
      const map = nav.createElement("map-outside-connection"); map.closest = () => null;
      pointer.pointerDown(map);
      assert.equal(pointer.render().find(node => node.props.id === "world-quick-menu"), undefined);
      assert.equal(nav.refreshes, 0);
    } finally { pointer.restore(); }
  }
});

test("the world portal yields Escape to an activity gate and keeps its existing open state while suspended", () => {
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  try {
    for (const [suspended, gate] of [[true, false], [false, true], [false, false]]) {
      hooks.reset(); hooks.render();
      Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => gate ? {} : null } });
      let closes = 0, innerEscapes = 0, prevented = false, stopped = false;
      const badge = createElement("button", { "data-test-connection-indicator": true });
      const portal = WorldPortal({ open: true, suspended, connectionStatus: badge, onClose() { closes++; }, origin: {}, returnFocus() { assert.fail("a retained dialog cannot return focus before closing"); } });
      const nodes = elements(portal), content = nodes.find(node => node.props["data-slot"] === "dialog-content");
      const view = nodes.find(node => node.type === WorldView);
      assert.ok(elements(content).some(node => node === badge), "the indicator belongs inside the world modal's accessible focus layer");
      view.props.escapeHandlerRef.current = () => { innerEscapes++; return false; };
      content.props.onEscapeKeyDown({ preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
      if (!prevented) portal.props.onOpenChange(false);
      assert.equal(portal.props.open, true); assert.equal(view.props.open, true); assert.equal(view.props.suspended, suspended);
      assert.equal(prevented, suspended || gate); assert.equal(stopped, suspended || gate);
      assert.equal(innerEscapes, suspended || gate ? 0 : 1, "the pause layer must precede pantry and selection escape handlers");
      assert.equal(closes, suspended || gate ? 0 : 1);
    }
  } finally {
    hooks.reset();
    if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument); else delete globalThis.document;
  }
});

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:world-onboarding-practice-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: "/tmp/zhiv-main-course-audit-practice-vite",
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "world-onboarding-practice-hooks", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots = [], cursor = 0, changed = false, pending = new Map(), collection = null, observation = null;
      export function reset() {
        for (const slot of slots) slot?.cleanup?.();
        slots = []; cursor = 0; changed = false; pending.clear(); collection = null; observation = null;
      }
      export function begin() { cursor = 0; changed = false; }
      export function invalidate() { changed = true; }
      export function dirty() { return changed; }
      export function useRef(initial) { return slots[cursor++] ??= { current: initial }; }
      export function useState(initial) {
        const index = cursor++;
        const slot = slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
        slot.set ??= next => {
          const value = typeof next === 'function' ? next(slot.value) : next;
          if (!Object.is(value, slot.value)) { slot.value = value; changed = true; }
        };
        return [slot.value, slot.set];
      }
      export function useEffect(effect, dependencies) {
        const index = cursor++, previous = slots[index];
        if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
          slots[index] = { dependencies, cleanup: previous?.cleanup };
          pending.set(index, effect);
        }
      }
      export function flush() {
        const effects = [...pending]; pending.clear();
        for (const [index, effect] of effects) {
          slots[index]?.cleanup?.(); slots[index].cleanup = effect();
        }
      }
      export function setCollection(value) { collection = value; }
      export function useGardenCollection() { return collection; }
      export function setObservation(value) { observation = value; }
      export function useForestObservation() { return observation; }
    `; },
    transform(source, id) {
      if (id.endsWith("/features/world/ui/onboarding/world-onboarding.tsx")) return source
        .replace('from "react";', `from "${hookModule}";`)
        .replace('import { useForestObservation } from "@/features/world/state/use-forest-observation";',
          `import { useForestObservation } from "${hookModule}";`)
        .replace('import { useGardenCollection } from "@/features/economy/integration/garden-collection-context";',
          `import { useGardenCollection } from "${hookModule}";`);
    },
  }],
});
const hooks = await vite.ssrLoadModule(hookModule);
const { WorldOnboarding, WorldOnboardingSession } = await vite.ssrLoadModule("/features/world/ui/onboarding/world-onboarding.tsx");
const { WorkshopRetry, WorkshopConstructionContents, TutorialOrderContents } = await vite.ssrLoadModule("/features/world/ui/onboarding/world-onboarding-cards.tsx");
const { tutorialResidentOrder, newTutorialOrder } = await vite.ssrLoadModule("/features/economy/domain/tutorial-order.ts");
const { transitionWorldOnboarding } = await vite.ssrLoadModule("/features/world/domain/world-onboarding.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const originalObserver = globalThis.MutationObserver;
const originalDocument = globalThis.document;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
const observers = new Set();
globalThis.document = { body: {} };
globalThis.requestAnimationFrame = callback => { callback(); return 1; };
globalThis.cancelAnimationFrame = () => {};
globalThis.MutationObserver = class {
  constructor(callback) { this.callback = callback; }
  observe(target) { this.target = target; observers.add(this); }
  disconnect() { observers.delete(this); }
};
after(async () => {
  hooks.reset();
  if (originalObserver) globalThis.MutationObserver = originalObserver;
  else delete globalThis.MutationObserver;
  if (originalDocument) globalThis.document = originalDocument;
  else delete globalThis.document;
  if (originalRequestAnimationFrame) globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  else delete globalThis.requestAnimationFrame;
  if (originalCancelAnimationFrame) globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  else delete globalThis.cancelAnimationFrame;
  await vite.close();
});

const now = Date.UTC(2026, 9, 8, 15), owner = "practice-player";
const crop = (id = "crop-1", finishesAt = now + 60000) => ({ id, kind: "production", targetId: "garden", recipeId: "grow_berries",
  startedAt: new Date(now - 60000).toISOString(), finishesAt: new Date(finishesAt).toISOString(), rewards: { berries: 6 },
  collection: { kind: "berry_harvest", seconds: 8, startedAt: null, finishesAt: null } });
const started = (stepId, jobId) => ({ version: 2, status: "started", stepId, ...(jobId ? { cropJobId: jobId } : {}) });
const gain = (patch = {}) => ({ id: "claim-receipt", ownerPublicId: owner, revision: 2, source: "claim", stationId: "garden",
  items: [{ itemId: "berries", quantity: 6 }], ...patch });

function harness(progress = started("grow"), jobs = [], { ordersPortal = false, session = false } = {}) {
  hooks.reset();
  const calls = [], surface = { garden: false, recipe: false, pantryItem: false, pantrySale: false, pantryRelics: false,
    routeActivities: false, routes: false, routePreparation: false, tutorialOrder: false, workshopSelected: false };
  const portal = { tutorialOrder: false }, visibility = { sceneReady: true, worldCovered: false, ordersCovered: false };
  const queries = { world: [], orders: [] };
  const notifySurface = () => { for (const observer of observers) observer.callback([]); };
  const snapshot = { ownerPublicId: owner, revision: 1, catalog: structuredClone(economyCatalog),
    wallet: { coins: 1000, pearls: 0 }, inventory: {}, buildings: { home: 3, warehouse: 1, garden: 1 }, jobs, workshopStarterClaimed: false,
    storage: { used: 0, reserved: 0, capacity: 200, available: 200 } };
  const forbidden = () => assert.fail("A coach cannot issue a production or harvest command");
  const economy = { snapshot, now, busy: false, uncertain: false, error: null, retryAt: 0, inventoryGains: [],
    act(action, target) {
      if (action === "claim_tutorial_order") { assert.equal(target, "tutorial_first_order"); calls.push(["claim-order", target]); }
      else assert.fail(`The coach cannot issue ${action}`);
    },
    actMarket: forbidden, refresh() { calls.push(["refresh"]); }, retry() { calls.push(["retry"]); } };
  const change = event => {
    const next = transitionWorldOnboarding(props.progress, event);
    if (JSON.stringify(next) !== JSON.stringify(props.progress)) { props.progress = next; hooks.invalidate(); }
  };
  const props = { open: true, modalBlocked: false, progress, economy, quickMenu: null, helpOpen: false, isOnline: true,
    residentOpen: null, ordersOpen: false, workshopOpen: false,
    worldElement: { current: { querySelector(selector) {
      queries.world.push(selector);
      if (selector === '[data-ready="true"] > canvas[role="img"]') return visibility.sceneReady ? {} : null;
      if (selector === '[data-place="garden"]') return surface.garden ? {} : null;
      if (selector === '[data-place="garden"] [data-recipe-product="berries"]') return surface.garden && surface.recipe ? { click() {
        assert.fail("Showing a production target must never press its one-tap action");
      } } : null;
      const content = { '[data-guide-pantry-item]': "pantryItem", '[data-guide-pantry-sale]': "pantrySale",
        '[data-guide-pantry-relics]': "pantryRelics", '[data-section-guide-target="expedition-activities"]': "routeActivities",
        '[data-section-guide-target="expedition-routes"]': "routes", '[data-route-preparation]': "routePreparation",
        '[data-tutorial-order="true"]': "tutorialOrder",
        '[data-place="workshop"] [role="tab"][aria-selected="true"][id$="-workshop"]': "workshopSelected" }[selector];
      if (content) return surface[content] ? {} : null;
      return null;
    }, closest(selector) { assert.equal(selector, '[aria-hidden="true"]'); return visibility.worldCovered ? {} : null; } } },
    ...(ordersPortal ? { ordersElement: { current: { querySelector(selector) {
      queries.orders.push(selector);
      return selector === '[data-tutorial-order="true"]' && portal.tutorialOrder ? {} : null;
    }, closest(selector) { assert.equal(selector, '[aria-hidden="true"]'); return visibility.ordersCovered ? {} : null; } } } } : {}),
    onStart() { calls.push(["start"]); change({ type: "start" }); },
    onStep(stepId) { calls.push(["step", stepId]); change({ type: "step", stepId }); },
    onCrop(jobId) { calls.push(["crop", jobId]); change({ type: "crop", jobId }); },
    onSkip() { calls.push(["skip"]); change({ type: "skip" }); },
    onComplete() { calls.push(["complete"]); change({ type: "complete" }); },
    onPause() { calls.push(["pause"]); props.open = false; },
    onOpenQuick(menu) { calls.push(["quick", menu]); props.quickMenu = menu; },
    onOpenGarden(recipe) { calls.push(["garden", recipe]); surface.garden = true; surface.recipe = Boolean(recipe); notifySurface(); },
    onOpenHelp() { calls.push(["help"]); props.helpOpen = true; props.modalBlocked = true; },
    onOpenResident(id) { calls.push(["resident", id]); props.residentOpen = id; props.modalBlocked = true; },
    onOpenOrders() { calls.push(["orders"]); props.ordersOpen = true; props.quickMenu = null;
      (ordersPortal ? portal : surface).tutorialOrder = Boolean(economy.snapshot.tutorialOrder?.ingredientsClaimed && !economy.snapshot.tutorialOrder?.completed); notifySurface(); },
    onOpenWorkshop(view) { calls.push(view ? ["workshop", view] : ["workshop"]); props.workshopOpen = true; props.modalBlocked = true; },
    onCloseSurface() { calls.push(["close-surface"]); props.quickMenu = null; props.helpOpen = false;
      props.residentOpen = null; props.ordersOpen = false; props.workshopOpen = false; props.modalBlocked = false;
      surface.garden = false; surface.recipe = false; notifySurface(); },
  };
  const render = () => {
    for (let pass = 0; pass < 20; pass++) {
      hooks.begin();
      const tree = session ? WorldOnboardingSession({ ...props, presenceKey: `practice:${owner}` }) : WorldOnboarding(props);
      if (hooks.dirty()) continue;
      hooks.flush();
      if (!hooks.dirty()) return tree?.props ?? null;
    }
    assert.fail("The coach did not settle after valid parent progress updates");
  };
  const patchEconomy = patch => { Object.assign(economy, patch); };
  const patchSnapshot = patch => { economy.snapshot = { ...economy.snapshot, ...patch }; };
  return { props, economy, surface, calls, queries, render, patchEconomy, patchSnapshot,
    revealSurface(garden, recipe) { surface.garden = garden; surface.recipe = recipe; notifySurface(); },
    revealContent(patch) { Object.assign(surface, patch); notifySurface(); },
    revealPortal(patch) { Object.assign(portal, patch); notifySurface(); },
    setVisibility(patch) { Object.assign(visibility, patch); notifySurface(); },
    setObservation(value) { hooks.setObservation(value); },
    setCollection(value) { hooks.setCollection(value); },
  };
}

test("a fresh main course still welcomes the player and starts only its local introduction", () => {
  const h = harness(null);
  const coach = h.render();
  assert.equal(coach.open, true);
  assert.equal(coach.welcome, true);
  assert.equal(coach.primary.label, "Давай попробуем");
  assert.equal(h.props.progress, null);
  assert.deepEqual(h.calls, []);
  coach.primary.onClick();
  assert.deepEqual(h.props.progress, started("profile"));
  assert.deepEqual(h.calls, [["start"]]);
});

test("practice points at the one-tap berry card without activating its production command", () => {
  const h = harness(started("garden"));
  let coach = h.render();
  assert.equal(coach.primary, undefined);
  assert.match(coach.summary, /Нажми на выделенный ягодный куст/);
  assert.deepEqual(h.calls, []);
  h.revealSurface(true, false);
  coach = h.render();
  assert.equal(coach.target, '[data-place="garden"] [data-recipe-product="berries"]');
  assert.equal(coach.primary, undefined);
  assert.equal(h.props.progress.stepId, "garden", "the guide waits until the real product card is mounted");
  h.revealSurface(true, true);
  coach = h.render();
  assert.equal(h.props.progress.stepId, "grow");
  assert.equal(coach.target, '[data-place="garden"] [data-recipe-product="berries"]');
  assert.equal(coach.primary, undefined, "the actual product card is the only start control");
  assert.match(coach.summary, /Нажми на карточку малины/);
  assert.doesNotMatch(coach.text, /«Начать»|подготовк|открой рецепт/);
  assert.deepEqual(h.economy.snapshot.jobs, []);
  assert.deepEqual(h.calls, [["step", "grow"]], "the guide changes only its local lesson, never clicks the action target");
});

test("berry practice targets the same product after upgrades and explains the automatic recipe's exact time", () => {
  for (const [gardenLevel, expected] of [[1, "1 мин"], [2, "45 с"], [3, "30 с"]]) {
    const h = harness(started("grow"));
    h.patchSnapshot({ buildings: { home: 3, warehouse: 1, garden: gardenLevel } });
    h.revealSurface(true, true);
    const coach = h.render();
    assert.equal(coach.target, '[data-place="garden"] [data-recipe-product="berries"]');
    assert.ok(coach.text.includes(`за ${expected}`), coach.text);
    assert.equal(coach.primary, undefined);
    assert.deepEqual(h.calls, []);
  }
});

test("the one-tap practice keeps blockers readable without issuing a command or advancing on a refused action", () => {
  for (const patch of [{ uncertain: true }, { isOnline: false }, { error: "Не хватает материалов" }]) {
    const h = harness(started("grow"));
    h.revealSurface(true, true);
    if (patch.isOnline === false) h.props.isOnline = false;
    else h.patchEconomy(patch);
    const coach = h.render();
    assert.equal(coach.target, '[data-place="garden"] [data-recipe-product="berries"]');
    assert.ok(coach.status);
    assert.equal(coach.primary, undefined);
    assert.deepEqual(h.props.progress, started("grow"));
    assert.deepEqual(h.calls, []);
  }
});

test("a confirmed crop can grow in the background while the guide advances, preserving its exact ID", () => {
  const jobs = [crop("later", now + 120000), crop("first", now + 30000)];
  const h = harness(started("grow"), jobs);
  const coach = h.render();
  assert.equal(h.props.progress.cropJobId, "first");
  assert.equal(coach.title, "Ягоды уже растут");
  assert.equal(coach.primary.label, "Продолжить знакомство");
  coach.primary.onClick();
  assert.deepEqual(h.props.progress, started("neighbors", "first"));
  assert.deepEqual(jobs.map(job => job.id), ["later", "first"], "the guide cannot reorder server jobs");
});

test("replayed raspberry practice never adopts another berry or celebrates its receipt", () => {
  const blueberry = { ...crop("blueberry", now), recipeId: "grow_blueberries", rewards: { blueberries: 1 } };
  const h = harness(started("grow"), [blueberry]);
  h.revealSurface(true, true);
  let coach = h.render();
  assert.equal(coach.title, "Посади первые ягоды");
  assert.equal(h.props.progress.cropJobId, undefined);
  assert.equal(coach.target, '[data-place="garden"] [data-recipe-product="berries"]');
  assert.deepEqual(h.calls, []);

  h.patchSnapshot({ revision: 2, jobs: [], inventory: { blueberries: 1 } });
  h.patchEconomy({ inventoryGains: [gain({ items: [{ itemId: "blueberries", quantity: 1 }] })] });
  assert.equal(h.render().title, "Посади первые ягоды");

  h.patchSnapshot({ revision: 3, jobs: [blueberry, crop("raspberry", now + 60_000)] });
  coach = h.render();
  assert.equal(h.props.progress.cropJobId, "raspberry", "an earlier blueberry cannot hide the actual raspberry practice");
  assert.equal(coach.title, "Ягоды уже растут");
  assert.deepEqual(h.economy.snapshot.jobs.map(job => job.id), ["blueberry", "raspberry"]);
});

test("an obsolete saved non-raspberry crop cannot show a completed-course harvest reminder", () => {
  const blueberry = { ...crop("blueberry", now), recipeId: "grow_blueberries", rewards: { blueberries: 1 } };
  const h = harness({ version: 2, status: "completed", cropJobId: blueberry.id }, [blueberry]);
  assert.equal(h.render(), null);
  assert.deepEqual(h.props.progress, { version: 2, status: "completed" });
  assert.deepEqual(h.economy.snapshot.jobs, [blueberry]);
  assert.deepEqual(h.calls, [["crop", undefined]], "only the obsolete tutorial reference is cleared");
});

test("ready mixed berries teach the real collect-all action and yield to a saved running harvest", () => {
  const raspberry = { ...crop("raspberry", now), rewards: { berries: 1 } };
  const blueberry = { ...crop("blueberry", now), recipeId: "grow_blueberries", rewards: { blueberries: 1 } };
  const h = harness(started("grow", raspberry.id), [raspberry, blueberry]);
  h.revealSurface(true, true);
  let coach = h.render();
  assert.match(coach.summary, /«Собрать всё \(2\)»/);
  assert.match(coach.text, /Все созревшие ягоды.*за один подход/);
  assert.equal(coach.target, '[data-job-id="raspberry"] button');
  h.setCollection({ jobId: raspberry.id, jobIds: [raspberry.id, blueberry.id], phase: "walking", request: null });
  coach = h.render();
  assert.match(coach.summary, /Сбор уже начат/);
  assert.equal(coach.target, undefined, "the guide must not ask for another click on a disabled collection button");
  assert.equal(coach.status, "Мохлик собирает урожай");
  assert.deepEqual(h.calls, []);
});

test("removing a crop without an accepted receipt never announces that the berries were received", () => {
  const h = harness(started("grow", "crop-1"), [crop("crop-1", now)]);
  h.render();
  h.patchSnapshot({ revision: 2, jobs: [], inventory: { berries: 6 } });
  const coach = h.render();
  assert.equal(h.props.progress.cropJobId, undefined);
  assert.equal(coach.title, "Посади первые ягоды");
  assert.doesNotMatch(coach.text, /Получение подтверждено/);
});

test("receipt celebrations reject purchases, old receipts, other owners and non-berry garden outputs", () => {
  for (const rejected of [gain({ source: "purchase" }), gain({ revision: 1 }), gain({ ownerPublicId: "another-player" }),
    gain({ stationId: "workshop" }), gain({ items: [{ itemId: "wood", quantity: 6 }] })]) {
    const h = harness(started("grow", "crop-1"), [crop("crop-1", now)]);
    h.render();
    h.patchSnapshot({ revision: 2, jobs: [] });
    h.patchEconomy({ inventoryGains: [rejected] });
    assert.equal(h.render().title, "Посади первые ягоды");
  }
});

test("a real accepted berry receipt celebrates once and points to the pantry without opening it", () => {
  const h = harness(started("grow", "crop-1"), [crop("crop-1", now)]);
  h.render();
  h.patchEconomy({ busy: true });
  h.patchSnapshot({ revision: 2, jobs: [], inventory: { berries: 6 } });
  h.render();
  assert.equal(h.props.progress.cropJobId, "crop-1", "in-flight snapshots cannot erase the tracked job before the receipt");
  h.patchEconomy({ inventoryGains: [gain()] });
  h.render();
  h.patchEconomy({ busy: false });
  const coach = h.render();
  assert.equal(coach.title, "Урожай в кладовой!");
  assert.match(coach.text, /Получение подтверждено/);
  assert.equal(h.props.progress.cropJobId, undefined);
  assert.equal(coach.target, '[data-world-quick="pantry"]');
  const offset = h.calls.length;
  coach.primary.onClick();
  assert.deepEqual(h.calls.slice(offset), [["close-surface"], ["step", "neighbors"]]);
  assert.equal(h.props.quickMenu, null, "a continuation button must not open the pantry for the player");
});

test("an accepted mixed garden batch celebrates the tracked berry once after deleting all collected jobs", () => {
  const tracked = { ...crop("crop-1", now), rewards: { berries: 1 }, collection: { kind: "berry_harvest", seconds: 8,
    batchId: "06b215a9-17aa-4949-8282-f7b4942f552c", startedAt: new Date(now - 8000).toISOString(), finishesAt: new Date(now).toISOString() } };
  const other = { ...tracked, id: "crop-2", recipeId: "grow_blueberries", rewards: { blueberries: 1 } };
  const growing = crop("crop-3", now + 60_000);
  const h = harness(started("grow", tracked.id), [tracked, other, growing]);
  h.render();
  h.patchSnapshot({ revision: 2, jobs: [growing], inventory: { berries: 1, blueberries: 1 } });
  h.patchEconomy({ inventoryGains: [gain({ id: tracked.collection.batchId, items: [{ itemId: "berries", quantity: 1 }, { itemId: "blueberries", quantity: 1 }] })] });
  const coach = h.render();
  assert.equal(coach.title, "Урожай в кладовой!");
  assert.equal(h.props.progress.cropJobId, undefined);
  assert.deepEqual(h.economy.snapshot.jobs.map(job => job.id), [growing.id]);
  coach.primary.onClick();
  h.props.progress = transitionWorldOnboarding(h.props.progress, { type: "replay" });
  h.render();
  h.props.progress = started("grow");
  assert.equal(h.render().title, "Ягоды уже растут", "the same batch receipt cannot celebrate the next growing crop");
});

test("replaying after a successful harvest cannot reuse the previous crop's success message", () => {
  const h = harness(started("grow", "crop-1"), [crop("crop-1", now)]);
  h.render();
  h.patchSnapshot({ revision: 2, jobs: [] });
  h.patchEconomy({ inventoryGains: [gain()] });
  assert.equal(h.render().title, "Урожай в кладовой!");
  h.props.progress = transitionWorldOnboarding(h.props.progress, { type: "replay" });
  h.render();
  h.props.progress = transitionWorldOnboarding(h.props.progress, { type: "step", stepId: "grow" });
  assert.equal(h.render().title, "Посади первые ягоды");
});

test("completed introductions retain a ready-crop reminder until harvesting or an explicit dismissal", () => {
  const h = harness({ version: 2, status: "completed", cropJobId: "crop-1" }, [crop("crop-1", now + 1000)]);
  assert.equal(h.render(), null, "a completed guide does not interrupt while berries are growing");
  h.patchEconomy({ now: now + 1000 });
  const coach = h.render();
  assert.equal(coach.stepId, "harvest");
  assert.equal(coach.title, "Пора собрать ягоды");
  assert.equal(coach.primary, undefined);
  assert.match(coach.summary, /Нажми на выделенный куст.*«Собрать»/);
  coach.onSkip();
  assert.deepEqual(h.props.progress, { version: 2, status: "completed" });
  assert.equal(h.render(), null);
});

test("help remains fully interactive while its modal owns focus, then returns the guide's completion action", () => {
  const h = harness(started("help"));
  let coach = h.render();
  assert.equal(coach.secondary, undefined);
  assert.equal(coach.target, '[data-world-onboarding-help]');
  h.props.helpOpen = true; h.props.modalBlocked = true;
  coach = h.render();
  assert.equal(coach.open, false, "the ordinary coach yields to the actual help modal");
  h.props.helpOpen = false; h.props.modalBlocked = false;
  coach = h.render();
  assert.equal(coach.primary.label, "Готово, буду играть");
  coach.primary.onClick();
  assert.equal(h.props.progress.status, "completed");
});

test("neighbors are learned through the real More and Characters path without shortcut cards", () => {
  const h = harness(started("neighbors"));
  let coach = h.render();
  assert.equal(coach.progress.total, 9);
  assert.equal(coach.children, undefined);
  assert.equal(coach.primary, undefined);
  assert.equal(coach.target, '[data-world-quick="more"]');
  h.props.quickMenu = "more";
  assert.equal(h.render().target, '[data-world-characters-trigger]');
  h.props.charactersOpen = true; h.props.modalBlocked = true;
  assert.equal(h.render().open, false);
  h.props.charactersOpen = false; h.props.modalBlocked = false;
  coach = h.render();
  assert.equal(coach.primary.label, "Дальше, к заказам");
  assert.deepEqual(h.calls, [], "the guide does not open a conversation or buy anything");
  coach.primary.onClick();
  assert.equal(h.props.progress.stepId, "orders");
  const skippedVisits = harness(started("neighbors"));
  skippedVisits.render().secondary.onClick();
  assert.equal(skippedVisits.props.progress.stepId, "orders");
  assert.ok(!skippedVisits.calls.some(call => call[0] === "resident"));
});

test("legacy order activation pins terms without a grant, then teaches manual navigation and submission", () => {
  const h = harness(started("orders"));
  let coach = h.render();
  assert.equal(coach.primary.label, "Открыть учебный заказ");
  assert.deepEqual(h.calls, []);
  const terms = tutorialResidentOrder(h.economy.snapshot);
  coach.primary.onClick(); coach.primary.onClick();
  assert.deepEqual(h.calls, [["claim-order", "tutorial_first_order"]], "two taps cannot enqueue two activations");
  assert.deepEqual(h.economy.snapshot.inventory, {});
  h.patchEconomy({ busy: true });
  assert.equal(h.render().primary.disabled, true);
  h.patchSnapshot({ revision: 2, tutorialOrder: { ingredientsClaimed: true, completed: false, terms } });
  h.patchEconomy({ busy: false });
  coach = h.render();
  assert.equal(coach.primary, undefined);
  assert.equal(coach.target, '[data-world-orders-entry]');
  assert.match(coach.status, /Припасов пока не хватает/);
  h.props.quickMenu = "more";
  assert.equal(h.render().target, '[data-world-orders-entry]', "orders have their own entry even while another menu is open");
  assert.doesNotMatch(coach.text, /Еда и заказы|«Ещё»|вкладк/);
  h.props.ordersOpen = true; h.revealContent({ tutorialOrder: true });
  coach = h.render();
  assert.equal(coach.target, '[data-order-id="tutorial_first_order"]');
  assert.match(coach.summary, /есть \/ нужно/);
  assert.equal(coach.primary, undefined, "submission remains on the real order card");
  h.revealContent({ tutorialOrder: false });
  assert.equal(h.render().target, '[data-order-filter="all"]');
  h.patchSnapshot({ revision: 3, tutorialOrder: { ingredientsClaimed: true, completed: true, terms } });
  coach = h.render();
  assert.equal(coach.title, "Учебный заказ выполнен!");
  coach.primary.onClick();
  assert.equal(h.props.progress.stepId, "workshop");
});

test("the journal lesson scopes its actual order and compact dock to the portal outside the map", () => {
  const h = harness(started("orders"), [], { ordersPortal: true });
  h.patchSnapshot({ tutorialOrder: newTutorialOrder(h.economy.snapshot.catalog) });
  let coach = h.render();
  assert.equal(coach.target, '[data-world-orders-entry]');
  assert.equal(coach.targetRoot, h.props.worldElement);
  assert.equal(coach.compact, false);
  assert.equal(coach.dock, undefined);
  assert.deepEqual(h.calls, []);

  // A stale order elsewhere on the map cannot count as content in the journal.
  h.revealContent({ tutorialOrder: true });
  h.props.ordersOpen = true;
  coach = h.render();
  assert.equal(coach.target, '[data-order-filter="all"]');
  assert.equal(coach.targetRoot, h.props.ordersElement);
  assert.equal(coach.compact, true);
  assert.equal(coach.dock, '[data-guide-coach-slot]');
  assert.ok(h.queries.orders.includes('[data-tutorial-order="true"]'));

  h.revealPortal({ tutorialOrder: true });
  coach = h.render();
  assert.equal(coach.target, '[data-order-id="tutorial_first_order"]');
  assert.match(coach.summary, /есть \/ нужно/);
  assert.equal(coach.primary, undefined, "only the real order card can submit inventory");
  assert.deepEqual(h.calls, []);

  h.patchSnapshot({ revision: 2, tutorialOrder: { ...h.economy.snapshot.tutorialOrder, step: 1,
    terms: h.economy.snapshot.catalog.onboarding.residentOrders[1] } });
  coach = h.render();
  assert.equal(coach.primary.label, "К мастерской");
  coach.primary.onClick();
  assert.deepEqual(h.calls, [["close-surface"], ["step", "workshop"]]);
  assert.equal(h.props.ordersOpen, false);
  assert.equal(h.render().targetRoot, h.props.worldElement);
});

test("a journal portal keeps the ready scene coach visible and yields to a nested fish dialog", () => {
  const h = harness(started("orders"), [], { ordersPortal: true, session: true });
  h.props.ordersOpen = true;
  h.setVisibility({ worldCovered: true });
  let child = h.render();
  assert.equal(child.open, true, "the journal may hide the map without hiding its own coach");
  assert.equal(child.ordersElement, h.props.ordersElement);
  assert.ok(h.queries.world.includes('[data-ready="true"] > canvas[role="img"]'));
  assert.deepEqual(h.queries.orders, [], "scene readiness is always measured on the map, not the journal");

  h.setVisibility({ ordersCovered: true });
  assert.equal(h.render().open, false, "the child modal owns its focus scope until it closes");
  h.setVisibility({ ordersCovered: false });
  assert.equal(h.render().open, true, "closing the picker restores the journal lesson without reopening it");
  h.setVisibility({ sceneReady: false });
  assert.equal(h.render().open, false, "a journal cannot make an unloaded map ready");
  h.setVisibility({ sceneReady: true });
  assert.equal(h.render().open, true);
  h.setObservation({ memory: { sync: { mode: "other-device" } } });
  assert.equal(h.render().open, false, "other-device ownership still pauses the whole lesson");
  assert.deepEqual(h.calls, [], "modal changes and readiness never spend inventory or start work");
});

test("closing the journal restores map coverage and hosts without a portal ref keep their scoped fallback", () => {
  const h = harness(started("orders"), [], { ordersPortal: true, session: true });
  h.props.ordersOpen = true;
  h.setVisibility({ worldCovered: true });
  assert.equal(h.render().open, true);
  h.props.ordersOpen = false;
  assert.equal(h.render().open, false, "after closing, coverage follows the map again");
  h.setVisibility({ worldCovered: false });
  assert.equal(h.render().open, true);

  const legacy = harness(started("orders"), [], { session: true });
  legacy.props.ordersOpen = true;
  assert.equal(legacy.render().open, true);
  legacy.setVisibility({ worldCovered: true });
  assert.equal(legacy.render().open, false, "without an orders ref the existing world ref remains authoritative");
});

test("a new player's first order advances the guide while the remaining three stay on the board", () => {
  const h = harness(started("orders"));
  h.patchSnapshot({ tutorialOrder: newTutorialOrder(h.economy.snapshot.catalog) });
  let coach = h.render();
  assert.equal(coach.primary, undefined, "the first request is already available without a claim");
  assert.match(coach.text, /две малины/);
  assert.deepEqual(h.calls, []);
  h.patchSnapshot({ revision: 2, tutorialOrder: { ...h.economy.snapshot.tutorialOrder, step: 1,
    terms: h.economy.snapshot.catalog.onboarding.residentOrders[1] } });
  h.patchEconomy({ uncertain: true });
  coach = h.render();
  assert.equal(coach.primary.disabled, true);
  assert.notEqual(coach.pose, "jump");
  h.patchEconomy({ uncertain: false });
  coach = h.render();
  assert.match(coach.summary, /1 \/ 4.*Следующая/);
  assert.equal(coach.primary.label, "К мастерской");
  coach.primary.onClick();
  assert.equal(h.props.progress.stepId, "workshop");
  assert.equal(h.economy.snapshot.tutorialOrder.completed, false);
  assert.deepEqual(h.calls.filter(call => call[0] === "claim-order"), []);
});

test("order activation respects offline and uncertain state, and full storage does not block a non-grant", () => {
  for (const blocked of ["offline", "uncertain"]) {
    const h = harness(started("orders"));
    if (blocked === "offline") h.props.isOnline = false;
    else h.patchEconomy({ uncertain: true });
    const coach = h.render();
    assert.equal(coach.primary.disabled, true, blocked);
    coach.primary.onClick();
    assert.deepEqual(h.calls, []);
    coach.secondary.onClick();
    assert.equal(h.props.progress.stepId, "workshop");
  }
  const h = harness(started("orders"));
  h.patchSnapshot({ storage: { ...h.economy.snapshot.storage, available: 0 } });
  const coach = h.render();
  assert.equal(coach.primary.disabled, false);
  coach.primary.onClick();
  assert.deepEqual(h.calls, [["claim-order", "tutorial_first_order"]]);
});

test("order ingredient card uses pinned terms without granting from rendering", () => {
  const h = harness(started("orders"));
  const terms = { ...tutorialResidentOrder(h.economy.snapshot), items: { berries: 4, stone: 2 } };
  h.patchSnapshot({ tutorialOrder: { ingredientsClaimed: true, completed: false, terms } });
  const text = visibleText(TutorialOrderContents({ economy: h.economy }));
  assert.match(text, /Малина: 4/);
  assert.match(text, /Камень: 2/);
  assert.deepEqual(h.calls, []);
});

function visibleText(node) {
  return typeof node === "string" || typeof node === "number" ? String(node)
    : Array.isArray(node) ? node.map(visibleText).join("") : node?.props ? visibleText(node.props.children) : "";
}

test("workshop introduction quotes real construction cost and never issues a gift or build command", () => {
  const h = harness(started("workshop"));
  let coach = h.render();
  assert.equal(coach.title, "Построим мастерскую");
  assert.equal(coach.primary, undefined);
  assert.match(coach.text, /5 мин/);
  assert.match(coach.text, /лесной участок и костёр/);
  assert.deepEqual(h.calls, []);
  assert.match(visibleText(WorkshopConstructionContents({ economy: h.economy })), /60 монет.*Бревно: 2.*Камень: 1/);
  h.patchSnapshot({ workshopStarterClaimed: true });
  assert.equal(h.render().title, "Построим мастерскую", "an old grant marker does not promise a new gift");
  h.props.workshopOpen = true;
  h.revealContent({ workshopSelected: true });
  coach = h.render();
  assert.equal(coach.target, '[data-guide-station-upgrade="workshop"]');
  assert.match(coach.summary, /«Открыть» в шапке/);
  h.props.modalBlocked = true;
  assert.equal(h.render().open, false);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.economy.snapshot.jobs, []);
  h.props.modalBlocked = false;
  h.render().secondary.onClick();
  assert.equal(h.props.progress.stepId, "expeditions");
});

test("uncertain workshop state offers the existing receipt retry without a grant control", () => {
  const h = harness(started("workshop"));
  h.patchEconomy({ uncertain: true, error: "Сеть прервалась" });
  const coach = h.render();
  assert.equal(coach.primary, undefined);
  assert.match(coach.status, /не подтверждён/);
  const retry = WorkshopRetry({ economy: h.economy, isOnline: true });
  assert.equal(retry.props.disabled, false);
  retry.props.onClick();
  assert.deepEqual(h.calls, [["retry"]]);
  h.patchEconomy({ retryAt: now + 6000 });
  assert.equal(WorkshopRetry({ economy: h.economy, isOnline: true }).props.disabled, true);
});

test("offline and full storage leave the workshop introduction and next lesson available", () => {
  for (const blocked of ["offline", "storage"]) {
    const h = harness(started("workshop"));
    if (blocked === "offline") h.props.isOnline = false;
    else h.patchSnapshot({ storage: { ...h.economy.snapshot.storage, available: 0 } });
    const coach = h.render();
    assert.equal(coach.primary, undefined);
    coach.secondary.onClick();
    assert.equal(h.props.progress.stepId, "expeditions");
    assert.deepEqual(h.calls.filter(call => call[0].startsWith("claim")), []);
  }
});

test("built workshops show their recipes and ongoing construction can continue in the background", () => {
  const built = harness(started("workshop"));
  built.patchSnapshot({ buildings: { ...built.economy.snapshot.buildings, workshop: 1 } });
  assert.equal(built.render().title, "Мастерская уже есть");
  built.props.workshopOpen = true;
  built.revealContent({ workshopSelected: true });
  let coach = built.render();
  assert.equal(coach.target, '[data-place="workshop"] [data-recipe-product="planks"]');
  assert.match(coach.summary, /одно бревно.*одну доску.*две минуты/);
  assert.match(coach.hint, /мастерской и печи отдельные очереди/);
  assert.deepEqual(built.calls, []);
  const pending = harness(started("workshop"), [{ id: "build-1", kind: "construction", targetId: "workshop", targetLevel: 1,
    finishesAt: new Date(now + 300000).toISOString() }]);
  coach = pending.render();
  assert.equal(coach.title, "Шишколап уже строит!");
  assert.match(coach.text, /5 мин/);
  coach.primary.onClick();
  assert.equal(pending.props.progress.stepId, "expeditions");
});

test("the shared kiln view teaches selecting the workshop before its plan or plank action", () => {
  for (const level of [0, 1]) {
    const h = harness(started("workshop"));
    h.patchSnapshot({ buildings: { ...h.economy.snapshot.buildings, workshop: level, kiln: 1 } });
    h.props.workshopOpen = true;
    let coach = h.render();
    assert.equal(coach.target, '[data-place="workshop"] [role="tab"][id$="-workshop"]');
    assert.match(coach.summary, /Выбери вкладку «Мастерская» в шапке/);
    assert.doesNotMatch(coach.summary, /Карточка доски сразу/);
    h.revealContent({ workshopSelected: true });
    coach = h.render();
    assert.equal(coach.target, level > 0 ? '[data-place="workshop"] [data-recipe-product="planks"]' : '[data-guide-station-upgrade="workshop"]');
    h.revealContent({ workshopSelected: false });
    assert.equal(h.render().target, '[data-place="workshop"] [role="tab"][id$="-workshop"]');
    assert.deepEqual(h.calls, [], "the coach must not change equipment, build or start the plank recipe");
  }
});

test("workshop costs and build time follow the catalog on replay without any grant", () => {
  const h = harness(started("workshop"));
  const catalog = structuredClone(h.economy.snapshot.catalog);
  const first = catalog.buildings.find(building => building.id === "workshop").levels[0];
  first.cost = { coins: 1500, items: { wood: 12, stone: 9 } }; first.seconds = 1500;
  h.patchSnapshot({ catalog, workshopStarterClaimed: true });
  const text = visibleText(WorkshopConstructionContents({ economy: h.economy }));
  assert.match(text, /1\s500 монет/);
  assert.match(text, /Бревно: 12/);
  assert.match(text, /Камень: 9/);
  assert.match(h.render().text, /25 мин/);
  assert.equal(h.render().primary, undefined);
  assert.deepEqual(h.calls, []);
});

test("the final lesson can finish immediately without another modal detour", () => {
  const h = harness(started("help"));
  h.render().primary.onClick();
  assert.equal(h.props.progress.status, "completed");
  assert.ok(!h.calls.some(call => call[0] === "help"));
});

test("opened sections highlight their contents, and pantry guidance follows the actual sale or relic surface", () => {
  const profile = harness(started("profile"));
  assert.equal(profile.render().target, '[data-world-quick="profile"]');
  assert.equal(profile.render().primary, undefined);
  profile.props.onOpenQuick("profile");
  assert.equal(profile.render().target, '[data-guide-profile-tabs]');

  const pantry = harness(started("pantry"));
  assert.equal(pantry.render().primary, undefined);
  pantry.props.onOpenQuick("pantry");
  assert.equal(pantry.render().target, '[data-guide-pantry-capacity]');
  pantry.revealContent({ pantryItem: true });
  let coach = pantry.render();
  assert.equal(coach.target, '[data-guide-pantry-item]');
  assert.match(coach.summary, /продажу/);
  assert.match(coach.text, /«Рынок».*игроками/);
  assert.match(coach.text, /по горизонтали.*небольшую панель.*повторное добавляет одну рыбу/);
  assert.match(coach.hint, /кнопка улучшения.*в шапке/);
  pantry.revealContent({ pantrySale: true });
  coach = pantry.render();
  assert.equal(coach.target, '[data-guide-pantry-sale]');
  assert.match(coach.summary, /количество.*итог.*кнопкой продажи/);
  pantry.revealContent({ pantryItem: false, pantrySale: false, pantryRelics: true });
  coach = pantry.render();
  assert.equal(coach.target, '[data-guide-pantry-relics]');
  assert.match(coach.summary, /продать их нельзя/);
  assert.deepEqual(pantry.calls, [["quick", "pantry"]], "explaining a sale must not trigger any transaction");
});

test("expedition guidance follows activity, route list and preparation without choosing or starting for the player", () => {
  const h = harness(started("expeditions"));
  assert.equal(h.render().primary, undefined);
  h.props.onOpenQuick("expeditions");
  let coach = h.render();
  assert.equal(coach.target, undefined, "loading must not highlight a nonexistent route card");
  h.revealContent({ routeActivities: true });
  coach = h.render();
  assert.equal(coach.target, '[data-section-guide-target="expedition-activities"]');
  assert.match(coach.summary, /Сначала выбери занятие/);
  h.revealContent({ routeActivities: false, routes: true });
  coach = h.render();
  assert.equal(coach.target, '[data-section-guide-target="expedition-routes"]');
  assert.match(coach.summary, /Нажми на маршрут/);
  h.revealContent({ routePreparation: true });
  coach = h.render();
  assert.equal(coach.target, '[data-route-preparation]');
  assert.match(coach.summary, /только по кнопке «Отправиться»/);
  assert.match(coach.text, /«Ускорение едой».*только по отдельной кнопке/);
  assert.match(coach.text, /Каменоломня.*отдельно/);
  h.revealContent({ routePreparation: false, routes: false, routeActivities: true });
  assert.equal(h.render().target, '[data-section-guide-target="expedition-activities"]', "back navigation follows the actual surface");
  assert.deepEqual(h.calls, [["quick", "expeditions"]]);
});

const saleReceipt = (patch = {}) => ({ id: "sale-1", ownerPublicId: owner, revision: 2, itemId: "wood", quantity: 1, coins: 2, ...patch });

test("a controlled nonmodal fish sale yields both coaches without changing the lesson or crop", () => {
  for (const session of [false, true]) {
    const h = harness(started("pantry", "held-crop"), [crop("held-crop")], { session });
    h.props.onOpenQuick("pantry");
    const progress = structuredClone(h.props.progress);
    assert.equal(h.render().open, true);
    h.props.fishSaleOpen = true;
    for (let index = 0; index < 3; index++) assert.equal(h.render().open, false, "yield does not depend on aria-hidden or a modal");
    assert.deepEqual(h.props.progress, progress);
    h.props.fishSaleOpen = false;
    const coach = h.render();
    assert.equal(coach.open, true);
    if (!session) assert.equal(coach.primary.label, "Попробуем вырастить ягоды", "closing restores the normal keyboard continuation");
    assert.deepEqual(h.props.progress, progress);
    assert.deepEqual(h.calls, [["quick", "pantry"]], "opening and closing must not sell, pause, skip or advance");
  }
});

test("an accepted fish sale is remembered while the coach yields and celebrated only after the panel closes", () => {
  const h = harness(started("pantry"));
  h.props.onOpenQuick("pantry");
  h.patchSnapshot({ inventory: { fish: 2 } });
  h.render();
  h.props.fishSaleOpen = true;
  h.patchSnapshot({ revision: 2, inventory: { fish: 1 }, wallet: { coins: 1040, pearls: 0 } });
  h.patchEconomy({ localSale: saleReceipt({ itemId: "fish", coins: 40 }), busy: true });
  assert.equal(h.render().open, false);
  h.patchEconomy({ busy: false });
  assert.equal(h.render().open, false);
  assert.equal(h.props.progress.stepId, "pantry");
  h.props.fishSaleOpen = false;
  const coach = h.render();
  assert.equal(coach.open, true);
  assert.match(coach.summary, /Продажа прошла.*Одной продажи достаточно/);
  assert.deepEqual(h.calls, [["quick", "pantry"]]);
  coach.primary.onClick();
  assert.deepEqual(h.calls.slice(-2), [["close-surface"], ["step", "garden"]]);
});

test("closing a nonmodal fish sale never fabricates success from an old, foreign or missing receipt", () => {
  for (const localSale of [undefined, saleReceipt({ revision: 1 }), saleReceipt({ ownerPublicId: "another-player" })]) {
    const h = harness(started("pantry"));
    h.props.onOpenQuick("pantry");
    h.render();
    h.props.fishSaleOpen = true;
    h.patchSnapshot({ revision: 2, wallet: { coins: 1040, pearls: 0 } });
    h.patchEconomy({ localSale });
    assert.equal(h.render().open, false);
    h.props.fishSaleOpen = false;
    const coach = h.render();
    assert.equal(coach.open, true);
    assert.doesNotMatch(coach.summary, /Продажа прошла/);
    assert.equal(h.props.progress.stepId, "pantry");
    assert.deepEqual(h.calls, [["quick", "pantry"]]);
  }
});

test("one confirmed pantry sale clearly offers next, survives closing the pantry, and waits for the player's choice", () => {
  const h = harness(started("pantry"));
  assert.equal(h.render().primary, undefined);
  h.props.onOpenQuick("pantry");
  h.revealContent({ pantryItem: true, pantrySale: true });
  h.render();
  h.patchSnapshot({ revision: 2 });
  h.patchEconomy({ localSale: saleReceipt(), busy: true });
  assert.doesNotMatch(h.render().summary, /Продажа прошла/);
  h.patchEconomy({ busy: false, uncertain: true });
  assert.doesNotMatch(h.render().summary, /Продажа прошла/);
  h.patchEconomy({ uncertain: false });
  let coach = h.render();
  assert.match(coach.summary, /Продажа прошла.*Одной продажи достаточно.*дальше/);
  assert.equal(coach.pose, "jump");
  assert.equal(coach.target, undefined, "do not keep asking the player to use the sale controls");
  assert.equal(coach.primary.advance, true);
  assert.equal(coach.primary.label, "Дальше, к ягодам");
  assert.deepEqual(h.calls, [["quick", "pantry"]], "a sale must not automatically close the menu or advance");
  h.props.quickMenu = null;
  assert.match(h.render().summary, /Одной продажи достаточно/);
  h.props.quickMenu = "pantry";
  coach = h.render();
  assert.match(coach.summary, /Одной продажи достаточно/);
  coach.primary.onClick();
  assert.equal(h.props.progress.stepId, "garden");
  h.props.progress = started("pantry");
  assert.doesNotMatch(h.render().summary, /Продажа прошла/, "replaying the lesson does not replay a stale receipt");
});

test("pantry practice never infers success from failed sales, changed wallets, old receipts or another owner", () => {
  const h = harness(started("pantry"));
  h.patchEconomy({ localSale: saleReceipt({ revision: 1 }) });
  assert.equal(h.render().primary, undefined);
  h.props.onOpenQuick("pantry");
  h.revealContent({ pantrySale: true });
  assert.doesNotMatch(h.render().summary, /Продажа прошла/);
  h.patchSnapshot({ revision: 4, wallet: { coins: 2000, pearls: 0 }, inventory: { wood: 4 } });
  h.patchEconomy({ error: "Продажа отклонена" });
  assert.doesNotMatch(h.render().summary, /Продажа прошла/);
  h.patchEconomy({ error: null, localSale: saleReceipt({ id: "foreign-sale", ownerPublicId: "another-player", revision: 5 }) });
  assert.doesNotMatch(h.render().summary, /Продажа прошла/);
  h.patchEconomy({ localSale: saleReceipt({ id: "fresh-sale", revision: 4 }) });
  assert.match(h.render().summary, /Продажа прошла/);
  h.patchSnapshot({ ownerPublicId: "another-player" });
  assert.doesNotMatch(h.render().summary, /Продажа прошла/, "changing accounts clears the previous owner's practice result");
});

test("completion reports actual crop and workshop progress without opening their destinations", () => {
  const untouched = harness(started("help"));
  assert.match(untouched.render().text, /Ягоды можно посадить/);
  assert.doesNotMatch(untouched.render().text, /Ягоды растут|Набор.*получен|Мастерская работает/);
  const growing = harness(started("help", "crop-1"), [crop("crop-1", now + 1000)]);
  assert.match(growing.render().text, /Ягоды растут/);
  growing.patchEconomy({ now: now + 1000 });
  let coach = growing.render();
  assert.match(coach.text, /Ягоды готовы/);
  assert.equal(coach.secondary, undefined);
  coach.primary.onClick();
  assert.equal(growing.props.progress.status, "completed");
  assert.deepEqual(growing.calls.slice(-2), [["close-surface"], ["complete"]]);

  const starter = harness(started("help"));
  starter.patchSnapshot({ workshopStarterClaimed: true });
  coach = starter.render();
  assert.match(coach.text, /Мастерскую можно построить за монеты и материалы/);
  assert.equal(coach.secondary, undefined);
  coach.primary.onClick();
  assert.equal(starter.props.progress.status, "completed");
  assert.deepEqual(starter.calls.slice(-2), [["close-surface"], ["complete"]]);
  assert.deepEqual(starter.economy.snapshot.jobs, []);
});

test("ninth lesson always explains the highlighted i button without opening details", () => {
  for (const jobs of [[], [crop("crop-1", now + 10000)], [{ id: "build-1", kind: "construction", targetId: "workshop", finishesAt: new Date(now + 60000).toISOString() }]]) {
    const h = harness(started("help", "crop-1"), jobs);
    const coach = h.render();
    assert.equal(coach.progress.current, 9);
    assert.equal(coach.progress.total, 9);
    assert.equal(coach.target, '[data-world-onboarding-help]');
    assert.match(coach.summary, /Кнопка i вверху открывает справку/);
    assert.match(coach.summary, /поиском/);
    assert.match(coach.summary, /«Что здесь делать\?»/);
    assert.match(coach.text, /профиль.*«\?».*«Повторить обучение»/);
    assert.match(coach.text, /«Продолжить обучение»/);
    assert.doesNotMatch(coach.hint, /В новых разделах я/);
    assert.deepEqual(h.calls.filter(call => !["crop"].includes(call[0])), []);
  }
});

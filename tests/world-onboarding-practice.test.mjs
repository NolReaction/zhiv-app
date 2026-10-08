import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:world-onboarding-practice-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "world-onboarding-practice-hooks", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots = [], cursor = 0, changed = false, pending = new Map(), collection = null;
      export function reset() {
        for (const slot of slots) slot?.cleanup?.();
        slots = []; cursor = 0; changed = false; pending.clear(); collection = null;
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
    `; },
    transform(source, id) {
      if (id.endsWith("/features/world/ui/onboarding/world-onboarding.tsx")) return source
        .replace('from "react";', `from "${hookModule}";`)
        .replace('import { useGardenCollection } from "@/features/economy/integration/garden-collection-context";',
          `import { useGardenCollection } from "${hookModule}";`);
    },
  }],
});
const hooks = await vite.ssrLoadModule(hookModule);
const { WorldOnboarding } = await vite.ssrLoadModule("/features/world/ui/onboarding/world-onboarding.tsx");
const { WorkshopRetry, WorkshopStarterContents } = await vite.ssrLoadModule("/features/world/ui/onboarding/world-onboarding-cards.tsx");
const { transitionWorldOnboarding } = await vite.ssrLoadModule("/features/world/domain/world-onboarding.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const originalObserver = globalThis.MutationObserver;
const observers = new Set();
globalThis.MutationObserver = class {
  constructor(callback) { this.callback = callback; }
  observe() { observers.add(this); }
  disconnect() { observers.delete(this); }
};
after(async () => {
  hooks.reset();
  if (originalObserver) globalThis.MutationObserver = originalObserver;
  else delete globalThis.MutationObserver;
  await vite.close();
});

const now = Date.UTC(2026, 9, 8, 15), owner = "practice-player";
const crop = (id = "crop-1", finishesAt = now + 60000) => ({ id, kind: "production", targetId: "garden", recipeId: "grow_berries",
  startedAt: new Date(now - 60000).toISOString(), finishesAt: new Date(finishesAt).toISOString(), rewards: { berries: 6 },
  collection: { kind: "berry_harvest", seconds: 8, startedAt: null, finishesAt: null } });
const started = (stepId, jobId) => ({ version: 2, status: "started", stepId, ...(jobId ? { cropJobId: jobId } : {}) });
const gain = (patch = {}) => ({ id: "claim-receipt", ownerPublicId: owner, revision: 2, source: "claim", stationId: "garden",
  items: [{ itemId: "berries", quantity: 6 }], ...patch });

function harness(progress = started("grow"), jobs = []) {
  hooks.reset();
  const calls = [], surface = { garden: false, recipe: false };
  const notifySurface = () => { for (const observer of observers) observer.callback([]); };
  const snapshot = { ownerPublicId: owner, revision: 1, catalog: structuredClone(economyCatalog),
    wallet: { coins: 1000, pearls: 0 }, inventory: {}, buildings: { home: 3, warehouse: 1, garden: 1 }, jobs, workshopStarterClaimed: false,
    storage: { used: 0, reserved: 0, capacity: 200, available: 200 } };
  const forbidden = () => assert.fail("A coach cannot issue a production or harvest command");
  const economy = { snapshot, now, busy: false, uncertain: false, error: null, retryAt: 0, inventoryGains: [],
    act(action, target) { assert.equal(action, "claim_workshop_starter"); assert.equal(target, "workshop"); calls.push(["claim-starter", target]); },
    actMarket: forbidden, refresh() { calls.push(["refresh"]); }, retry() { calls.push(["retry"]); } };
  const change = event => {
    const next = transitionWorldOnboarding(props.progress, event);
    if (JSON.stringify(next) !== JSON.stringify(props.progress)) { props.progress = next; hooks.invalidate(); }
  };
  const props = { open: true, modalBlocked: false, progress, economy, quickMenu: null, helpOpen: false, isOnline: true,
    residentOpen: null, ordersOpen: false, workshopOpen: false,
    worldElement: { current: { querySelector(selector) {
      if (selector === '[data-place="garden"]') return surface.garden ? {} : null;
      if (selector === '[data-recipe-preparation="grow_berries"]') return surface.recipe ? {} : null;
      if (selector === '[data-recipe="grow_berries"]') return surface.garden ? { click() {
        calls.push(["choose-recipe"]); surface.recipe = true; notifySurface();
      } } : null;
      return null;
    } } },
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
    onOpenOrders() { calls.push(["orders"]); props.ordersOpen = true; props.quickMenu = "food"; },
    onOpenWorkshop(view) { calls.push(view ? ["workshop", view] : ["workshop"]); props.workshopOpen = true; props.modalBlocked = true; },
    onCloseSurface() { calls.push(["close-surface"]); props.quickMenu = null; props.helpOpen = false;
      props.residentOpen = null; props.ordersOpen = false; props.workshopOpen = false; props.modalBlocked = false;
      surface.garden = false; surface.recipe = false; notifySurface(); },
  };
  const render = () => {
    for (let pass = 0; pass < 20; pass++) {
      hooks.begin();
      const tree = WorldOnboarding(props);
      if (hooks.dirty()) continue;
      hooks.flush();
      if (!hooks.dirty()) return tree?.props ?? null;
    }
    assert.fail("The coach did not settle after valid parent progress updates");
  };
  const patchEconomy = patch => { Object.assign(economy, patch); };
  const patchSnapshot = patch => { economy.snapshot = { ...economy.snapshot, ...patch }; };
  return { props, economy, surface, calls, render, patchEconomy, patchSnapshot,
    revealSurface(garden, recipe) { surface.garden = garden; surface.recipe = recipe; notifySurface(); },
    setCollection(value) { hooks.setCollection(value); },
  };
}

test("practice opens the real berry surface and recipe without starting a job for the player", () => {
  const h = harness(started("garden"));
  let coach = h.render();
  assert.equal(coach.primary.label, "Показать ягодный куст");
  coach.primary.onClick();
  coach = h.render();
  assert.equal(coach.target, '[data-recipe="grow_berries"]');
  assert.equal(coach.primary.label, "Выбрать ягоды");
  coach.primary.onClick();
  coach = h.render();
  assert.equal(h.props.progress.stepId, "grow");
  assert.equal(coach.primary, undefined, "the actual recipe button is the only start control");
  assert.deepEqual(h.economy.snapshot.jobs, []);
  assert.ok(h.calls.some(call => call[0] === "choose-recipe"));
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

test("a real accepted berry receipt celebrates once and its action leaves the pantry open", () => {
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
  const offset = h.calls.length;
  coach.primary.onClick();
  assert.deepEqual(h.calls.slice(offset), [["close-surface"], ["step", "neighbors"], ["quick", "pantry"]]);
  assert.equal(h.props.quickMenu, "pantry", "the success action must not close the pantry immediately after opening it");
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
  assert.equal(coach.primary.label, "Открыть урожай");
  coach.onSkip();
  assert.deepEqual(h.props.progress, { version: 2, status: "completed" });
  assert.equal(h.render(), null);
});

test("help remains fully interactive while its modal owns focus, then returns the guide's completion action", () => {
  const h = harness(started("help"));
  let coach = h.render();
  coach.secondary.onClick();
  coach = h.render();
  assert.equal(coach.open, false, "the ordinary coach yields to the actual help modal");
  h.props.helpOpen = false; h.props.modalBlocked = false;
  coach = h.render();
  assert.equal(coach.primary.label, "Готово, буду играть");
  coach.primary.onClick();
  assert.equal(h.props.progress.status, "completed");
});

test("neighbor cards open real conversations and yield focus, with no mandatory visit or purchase", () => {
  const h = harness(started("neighbors"));
  let coach = h.render();
  assert.equal(coach.progress.total, 9);
  for (const [index, id] of [[0, "plesk"], [1, "builder"]]) {
    const cards = coach.children.type(coach.children.props);
    cards.props.children[index].props.onClick();
    assert.deepEqual(h.calls.at(-1), ["resident", id]);
    assert.equal(h.render().open, false);
    h.props.residentOpen = null; h.props.modalBlocked = false;
    coach = h.render();
    assert.equal(coach.open, true);
    assert.equal(h.props.progress.stepId, "neighbors");
  }
  coach.primary.onClick();
  assert.equal(h.props.progress.stepId, "orders");
  const skippedVisits = harness(started("neighbors"));
  skippedVisits.render().primary.onClick();
  assert.equal(skippedVisits.props.progress.stepId, "orders");
  assert.ok(!skippedVisits.calls.some(call => call[0] === "resident"));
});

test("orders let players inspect the actual board and continue without producing or handing over goods", () => {
  const h = harness(started("orders"));
  let coach = h.render();
  assert.equal(coach.primary.label, "Посмотреть заказы");
  assert.equal(coach.target, undefined);
  coach.primary.onClick();
  assert.equal(h.props.ordersOpen, true);
  assert.deepEqual(h.calls, [["orders"]]);
  coach = h.render();
  assert.equal(coach.target, '[data-world-food-tab="orders"]');
  assert.equal(coach.primary.label, "К мастерской");
  coach.primary.onClick();
  assert.equal(h.props.progress.stepId, "workshop");
  const skip = harness(started("orders"));
  skip.render().secondary.onClick();
  assert.equal(skip.props.progress.stepId, "workshop");
});

test("starter gift is explicit and celebrates only the server marker, with construction left to its real dialog", () => {
  const h = harness(started("workshop"));
  let coach = h.render();
  assert.equal(coach.primary.label, "Получить набор");
  assert.equal(coach.primary.disabled, false);
  assert.deepEqual(h.calls, [], "rendering a tutorial cannot issue economy commands");
  coach.primary.onClick();
  assert.deepEqual(h.calls, [["claim-starter", "workshop"]]);
  assert.equal(h.economy.snapshot.wallet.coins, 1000);
  assert.deepEqual(h.economy.snapshot.inventory, {});
  h.patchEconomy({ busy: true });
  assert.doesNotMatch(h.render().title, /получен/);
  h.patchSnapshot({ revision: 2, workshopStarterClaimed: true, wallet: { coins: 2200, pearls: 0 }, inventory: { wood: 10, stone: 8 } });
  h.patchEconomy({ busy: false });
  coach = h.render();
  assert.equal(coach.title, "Набор для мастерской получен");
  assert.match(coach.text, /20 мин/);
  assert.equal(coach.pose, "jump");
  coach.primary.onClick();
  assert.deepEqual(h.calls.at(-1), ["workshop"]);
  assert.equal(h.render().open, false, "construction has the screen and focus");
  assert.deepEqual(h.economy.snapshot.jobs, [], "the tutorial never constructs automatically");
  h.props.modalBlocked = false; h.props.workshopOpen = false;
  h.render().secondary.onClick();
  assert.equal(h.props.progress.stepId, "expeditions");
});

test("gift waits through an uncertain request and exposes the existing exact-receipt retry", () => {
  const h = harness(started("workshop"));
  h.patchEconomy({ uncertain: true, error: "Сеть прервалась" });
  const coach = h.render();
  assert.equal(coach.primary.disabled, true);
  coach.primary.onClick();
  assert.deepEqual(h.calls, []);
  assert.doesNotMatch(coach.title, /получен/);
  assert.match(coach.status, /не подтверждён/);
  const retry = WorkshopRetry({ economy: h.economy, isOnline: true });
  assert.equal(retry.props.disabled, false);
  retry.props.onClick();
  assert.deepEqual(h.calls, [["retry"]]);
  h.patchEconomy({ retryAt: now + 6000 });
  assert.equal(WorkshopRetry({ economy: h.economy, isOnline: true }).props.disabled, true);
});

test("offline and full storage block starter claims while leaving the next lesson available", () => {
  for (const blocked of ["offline", "storage"]) {
    const h = harness(started("workshop"));
    if (blocked === "offline") h.props.isOnline = false;
    else h.patchSnapshot({ storage: { ...h.economy.snapshot.storage, available: 17 } });
    const coach = h.render();
    assert.equal(coach.primary.disabled, true);
    coach.primary.onClick();
    assert.deepEqual(h.calls, []);
    coach.secondary.onClick();
    assert.equal(h.props.progress.stepId, "expeditions");
  }
});

test("existing workshops offer upgrades and existing construction proceeds without a second starter gift", () => {
  const built = harness(started("workshop"));
  built.patchSnapshot({ buildings: { ...built.economy.snapshot.buildings, workshop: 1 } });
  let coach = built.render();
  assert.equal(coach.title, "Мастерская уже есть");
  assert.equal(coach.primary.label, "Посмотреть улучшение");
  coach.primary.onClick();
  assert.deepEqual(built.calls, [["workshop"]]);
  built.props.modalBlocked = false; built.props.workshopOpen = false;
  const maxLevel = Math.max(...built.economy.snapshot.catalog.buildings.find(building => building.id === "workshop").levels.map(level => level.level));
  built.patchSnapshot({ buildings: { ...built.economy.snapshot.buildings, workshop: maxLevel } });
  coach = built.render();
  assert.equal(coach.primary.label, "Открыть мастерскую");
  coach.primary.onClick();
  assert.deepEqual(built.calls.at(-1), ["workshop", "recipes"]);
  const pending = harness(started("workshop"), [{ id: "build-1", kind: "construction", targetId: "workshop", targetLevel: 1,
    finishesAt: new Date(now + 1200000).toISOString() }]);
  coach = pending.render();
  assert.equal(coach.title, "Шишколап уже строит!");
  assert.match(coach.text, /20 мин/);
  assert.deepEqual(pending.calls, []);
  coach.primary.onClick();
  assert.equal(pending.props.progress.stepId, "expeditions");
});

test("gift quantities and build time follow the current catalog, and replay cannot grant again", () => {
  const h = harness(started("workshop"));
  const catalog = structuredClone(h.economy.snapshot.catalog);
  const first = catalog.buildings.find(building => building.id === "workshop").levels[0];
  first.cost = { coins: 1500, items: { wood: 12, stone: 9 } }; first.seconds = 1500;
  h.patchSnapshot({ catalog });
  const contents = WorkshopStarterContents({ economy: h.economy });
  const visibleText = node => typeof node === "string" || typeof node === "number" ? String(node)
    : Array.isArray(node) ? node.map(visibleText).join("") : node?.props ? visibleText(node.props.children) : "";
  const serialized = visibleText(contents);
  assert.match(serialized, /1\s500 монет/);
  assert.match(serialized, /Древесина: 12/);
  assert.match(serialized, /Камень: 9/);
  h.patchSnapshot({ workshopStarterClaimed: true });
  const coach = h.render();
  assert.match(coach.text, /25 мин/);
  assert.equal(coach.primary.label, "Построим мастерскую?");
  assert.deepEqual(h.calls, []);
});

test("the final lesson can finish immediately without another modal detour", () => {
  const h = harness(started("help"));
  h.render().primary.onClick();
  assert.equal(h.props.progress.status, "completed");
  assert.ok(!h.calls.some(call => call[0] === "help"));
});

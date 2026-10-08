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
    wallet: { coins: 1000, pearls: 0 }, inventory: {}, buildings: { home: 3, warehouse: 1, garden: 1 }, jobs,
    storage: { used: 0, reserved: 0, capacity: 200, available: 200 } };
  const forbidden = () => assert.fail("A coach cannot issue a production or harvest command");
  const economy = { snapshot, now, busy: false, uncertain: false, error: null, retryAt: 0, inventoryGains: [],
    act: forbidden, actMarket: forbidden, refresh: forbidden, retry: forbidden };
  const change = event => {
    const next = transitionWorldOnboarding(props.progress, event);
    if (JSON.stringify(next) !== JSON.stringify(props.progress)) { props.progress = next; hooks.invalidate(); }
  };
  const props = { open: true, modalBlocked: false, progress, economy, quickMenu: null, helpOpen: false, isOnline: true,
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
    onCloseSurface() { calls.push(["close-surface"]); props.quickMenu = null; props.helpOpen = false;
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
  assert.deepEqual(h.props.progress, started("expeditions", "first"));
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
  assert.deepEqual(h.calls.slice(offset), [["close-surface"], ["step", "expeditions"], ["quick", "pantry"]]);
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
  coach.primary.onClick();
  coach = h.render();
  assert.equal(coach.open, false, "the ordinary coach yields to the actual help modal");
  h.props.helpOpen = false; h.props.modalBlocked = false;
  coach = h.render();
  assert.equal(coach.primary.label, "Готово, буду играть");
  coach.primary.onClick();
  assert.equal(h.props.progress.status, "completed");
});

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hooksId = "virtual:visible-production-slots-hooks";
// Exercise the real purchase handlers and work/collection controls without a
// browser dependency. Only the component's hook storage is substituted.
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-slot-ui-vite-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "visible-production-slots-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let slots = [], cursor = 0, pending = [], collection = null;
      function dispose() { slots.forEach(slot => { if (typeof slot?.cleanup === 'function') slot.cleanup(); }); }
      export function reset() { dispose(); slots = []; cursor = 0; pending = []; collection = null; }
      export function render() { cursor = 0; }
      export function capture() { return slots; }
      export function restore(value) { if (slots !== value) dispose(); slots = value; cursor = 0; pending = []; }
      export function flush() { const effects = pending; pending = []; effects.forEach(effect => effect()); }
      export function useState(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
      }
      export function useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; }
      export function useId() { return 'production-slot-confirmation'; }
      export function useEffect(effect, dependencies) {
        const index = cursor++, previous = slots[index];
        if (!previous || dependencies.some((value, position) => !Object.is(value, previous.dependencies[position]))) {
          previous?.cleanup?.();
          const entry = { dependencies, cleanup: null }; slots[index] = entry;
          pending.push(() => { if (slots[index] !== entry) return; entry.cleanup = effect(); });
        }
      }
      export function useGardenCollection() { return collection; }
      export function setCollection(value) { collection = value; }
    `; },
    transform(source, id) {
      if (id.endsWith("/features/economy/ui/production/world-production-slots.tsx")) return source.replace('from "react";', `from "${hooksId}";`);
      if (id.endsWith("/features/economy/ui/shared/world-economy-parts.tsx")) return source.replace('from "@/features/economy/integration/garden-collection-context";', `from "${hooksId}";`);
      if (id.endsWith("/features/economy/ui/production/production-work.tsx")) return source
        .replace('from "react";', `from "${hooksId}";`)
        .replace('from "@/features/economy/integration/garden-collection-context";', `from "${hooksId}";`);
      if (id.endsWith("/features/economy/ui/stations/world-object-menu.tsx")) return source
        .replace('from "react";', `from "${hooksId}";`)
        .replace('from "@/features/economy/integration/garden-collection-context";', `from "${hooksId}";`) + "\nexport { ObjectMenuBody as TestSlotMenuBody };";
      if (id.endsWith("/features/economy/ui/economy-panel.tsx")) return source
        .replace('from "react";', `from "${hooksId}";`)
        .replace('from "@/features/economy/integration/garden-collection-context";', `from "${hooksId}";`) + "\nexport { Production as TestSlotProduction, JobCard as TestSlotJobCard };";
    },
  }],
});
after(() => { hooks.reset(); return vite.close(); });
const hooks = await vite.ssrLoadModule(hooksId);
const { WorldProductionSlots } = await vite.ssrLoadModule("/features/economy/ui/production/world-production-slots.tsx");
const { Work } = await vite.ssrLoadModule("/features/economy/ui/shared/world-economy-parts.tsx");
const { ProductionWork } = await vite.ssrLoadModule("/features/economy/ui/production/production-work.tsx");
const { worldCountdown, worldDuration } = await vite.ssrLoadModule("/features/economy/ui/shared/world-stations.ts");
const { TestSlotMenuBody } = await vite.ssrLoadModule("/features/economy/ui/stations/world-object-menu.tsx");
const { TestSlotProduction, TestSlotJobCard } = await vite.ssrLoadModule("/features/economy/ui/economy-panel.tsx");
const { WorldStationSetup } = await vite.ssrLoadModule("/features/economy/ui/construction/world-station-setup.tsx");
const { WorldUpgradeDialog } = await vite.ssrLoadModule("/features/economy/ui/construction/world-upgrade-dialog.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const now = Date.parse("2026-10-14T19:00:00Z");
function controller(overrides = {}) {
  return { snapshot: { ownerPublicId: "ME", revision: 2, buildings: { home: 1, woodlot: 1, garden: 1, warehouse: 1 },
    productionSlots: {}, wallet: { coins: 0, pearls: 2000 }, inventory: {}, jobs: [], storage: { capacity: 50, used: 0, available: 50, reserved: 0 },
    catalog: structuredClone(economyCatalog) }, busy: false, uncertain: false, error: null, now, retryAt: 0, act() {}, ...overrides };
}
function elements(tree) {
  const found = [];
  function visit(node) { if (!isValidElement(node)) return; found.push(node); Children.forEach(node.props.children, visit); }
  visit(tree); return found;
}
function render(economy, stationId = "woodlot") {
  hooks.render(); return WorldProductionSlots({ economy, stationId });
}
let workKey;
function renderWork(entry, props) {
  hooks.render(); let tree = entry(props);
  while (isValidElement(tree) && typeof tree.type === "function") {
    if (tree.key && tree.key !== workKey) { workKey = tree.key; hooks.restore([]); hooks.render(); }
    tree = tree.type(tree.props);
  }
  return tree;
}
function card(tree, slot) { return elements(tree).find(node => node.type === "button" && node.props["data-production-slot"] === slot); }
function buy(tree) { return elements(tree).find(node => node.type === "button" && Children.toArray(node.props.children).some(child => typeof child === "string" && child.includes("Купить за"))); }
function cancel(tree) { return elements(tree).find(node => node.type === "button" && node.props.children === "Отмена"); }
function click(node, extra = {}) { assert.ok(node); node.props.onClick({ currentTarget: { focus() {} }, ...extra }); }
function production(id, targetId = "woodlot", overrides = {}) {
  return { id, kind: "production", targetId, recipeId: targetId === "garden" ? "grow_berries" : "gather_wood",
    startedAt: new Date(now - 60_000).toISOString(), finishesAt: new Date(now + 120_000).toISOString(),
    rewards: targetId === "garden" ? { berries: 1 } : { wood: 1 }, cost: { coins: 0, items: {} }, ...overrides };
}

function withMonotonicClock(run) {
  hooks.reset();
  const previous = { performance: globalThis.performance, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  let current = 100_000, nextId = 0;
  const intervals = new Map();
  globalThis.performance = { now: () => current };
  globalThis.setInterval = callback => { const id = ++nextId; intervals.set(id, callback); return id; };
  globalThis.clearInterval = id => intervals.delete(id);
  try { return run({ advance(milliseconds, callbacks = true) { current += milliseconds; if (callbacks) [...intervals.values()].forEach(callback => callback()); }, intervals }); }
  finally { hooks.reset(); Object.assign(globalThis, previous); }
}

test("opening, cancelling and dismissing purchase confirmation never spends pearls", () => {
  hooks.reset(); const calls = [], economy = controller({ act: (...args) => calls.push(args) });
  let tree = render(economy); assert.equal(elements(tree).filter(node => node.props["data-production-slot"]).length, 3);
  let focused = 0; const trigger = { isConnected: true, focus() { focused++; } };
  click(card(tree, 2), { currentTarget: trigger }); tree = render(economy);
  const dialog = elements(tree).find(node => node.props.role === "dialog");
  assert.ok(dialog); assert.equal(dialog.props["aria-labelledby"], "production-slot-confirmation-title");
  assert.equal(buy(tree).props.disabled, false); assert.deepEqual(calls, []);
  click(cancel(tree)); assert.equal(focused, 1); assert.equal(buy(render(economy)), undefined);
  click(card(render(economy), 2)); tree = render(economy);
  const event = { key: "Escape", prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; } };
  elements(tree).find(node => node.props.role === "dialog").props.onKeyDown(event);
  assert.equal(event.prevented, 1); assert.equal(event.stopped, 1); assert.deepEqual(calls, []);
  assert.equal(buy(render(economy)), undefined);
});

test("ripe slot and hub buttons gather all berries and explain the combined warehouse capacity", () => {
  hooks.reset(); const calls = [], economy = controller({ act: (...args) => { calls.push(args); return true; } });
  economy.snapshot.productionSlots.garden = 3;
  economy.snapshot.jobs = ["berries", "strawberries", "blueberries"].map((itemId, index) => production(`berry-${index}`, "garden", {
    finishesAt: new Date(now).toISOString(), rewards: { [itemId]: 1 }, collection: { kind: "berry_harvest", seconds: 8, startedAt: null, finishesAt: null },
  }));
  economy.snapshot.storage.available = 2;
  for (const entry of [Work, TestSlotJobCard]) {
    const tree = renderWork(entry, { economy, job: economy.snapshot.jobs[0], compact: true, navigate() {} });
    const button = elements(tree).find(node => node.type === "button");
    assert.match(renderToStaticMarkup(tree), /Собрать всё \(3\)/); assert.equal(button.props.disabled, true);
    click(button); assert.equal(calls.length, 0);
    assert.match(renderToStaticMarkup(tree), /Нужно освободить 1 мест/);
  }
  economy.snapshot.storage.available = 3;
  let tree = renderWork(Work, { economy, job: economy.snapshot.jobs[0], compact: true }); click(elements(tree).find(node => node.type === "button"));
  assert.deepEqual(calls, [["start_garden_collection", "berry-0"]]);
  const batchId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  for (const crop of economy.snapshot.jobs) crop.collection = { ...crop.collection, batchId, startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 8000).toISOString() };
  hooks.setCollection({ jobId: "berry-0", jobIds: ["berry-0", "berry-1", "berry-2"], phase: "walking", start() { assert.fail("collecting neighbors must not launch another walk"); } });
  for (const crop of economy.snapshot.jobs) {
    tree = renderWork(Work, { economy, job: crop, compact: true }); const button = elements(tree).find(node => node.type === "button");
    assert.equal(button.props.disabled, true); assert.match(renderToStaticMarkup(tree), /Мохлик собирает урожай/); click(button);
  }
  hooks.setCollection(null); economy.now += 8000;
  for (const entry of [Work, TestSlotJobCard]) {
    tree = renderWork(entry, { economy, job: economy.snapshot.jobs[1], compact: true, navigate() {} }); click(elements(tree).find(node => node.type === "button"));
    assert.deepEqual(calls.at(-1), ["claim_garden_collection", batchId], "without a scene provider the saved batch still claims atomically");
  }
});

test("confirmation focuses cancel first and a completed purchase returns focus to its production section", () => {
  hooks.reset(); const economy = controller(); let sectionFocus = 0, cancelFocus = 0;
  const trigger = { isConnected: true, focus() {} };
  let tree = render(economy); tree.props.ref.current = { focus() { sectionFocus++; } };
  click(card(tree, 2), { currentTarget: trigger }); tree = render(economy);
  cancel(tree).props.ref.current = { focus() { cancelFocus++; } }; hooks.flush();
  assert.equal(cancelFocus, 1);
  click(buy(tree)); trigger.isConnected = false; economy.snapshot.productionSlots.woodlot = 2; economy.snapshot.revision++;
  tree = render(economy); hooks.flush();
  assert.equal(buy(tree), undefined); assert.equal(sectionFocus, 1);
});

test("only explicit confirmation buys the next station tier and double clicks cannot submit twice", () => {
  hooks.reset(); const calls = [], economy = controller({ act: (...args) => calls.push(args) });
  click(card(render(economy), 2)); let tree = render(economy);
  const confirmationButton = buy(tree); click(confirmationButton); click(confirmationButton);
  assert.deepEqual(calls, [["buy_production_slot", "woodlot"]]);
  assert.equal(buy(render(economy)), undefined);
  economy.snapshot.productionSlots.woodlot = 2; economy.snapshot.revision++; render(economy); hooks.flush();
  click(card(render(economy), 3)); tree = render(economy);
  assert.match(renderToStaticMarkup(tree), /Купить за 250/); click(buy(tree));
  assert.deepEqual(calls, [["buy_production_slot", "woodlot"], ["buy_production_slot", "woodlot"]]);
});

test("the third place is inert without a visible or accessible price until the second is bought", () => {
  hooks.reset(); const calls = [], economy = controller({ act: (...args) => calls.push(args) });
  const third = card(render(economy), 3), html = renderToStaticMarkup(third);
  assert.equal(third.props.disabled, true); assert.match(html, /Закрыто/);
  assert.doesNotMatch(html, /250|pearls|жемчужин|aria-haspopup|aria-expanded/);
  click(third); assert.equal(buy(render(economy)), undefined); assert.deepEqual(calls, []);
  economy.snapshot.productionSlots.woodlot = 2; economy.snapshot.revision++;
  const available = card(render(economy), 3);
  assert.equal(available.props.disabled, false); assert.match(renderToStaticMarkup(available), /250/);
  click(available); assert.match(renderToStaticMarkup(render(economy)), /Купить за 250/);
});

test("insufficient funds or unconfirmed state block purchase confirmation", () => {
  for (const scenario of ["poor", "busy", "uncertain", "cooldown", "error"]) {
    hooks.reset(); const calls = [], economy = controller({ act: (...args) => calls.push(args) });
    let slot = 2;
    if (scenario === "poor") economy.snapshot.wallet.pearls = 199;
    if (scenario === "busy") economy.busy = true;
    if (scenario === "uncertain") economy.uncertain = true;
    if (scenario === "cooldown") economy.retryAt = now + 1000;
    if (scenario === "error") economy.error = "Network failure";
    click(card(render(economy), slot)); const tree = render(economy);
    const confirmationButton = buy(tree); assert.equal(confirmationButton.props.disabled, true, scenario);
    click(confirmationButton); assert.deepEqual(calls, [], scenario);
    if (scenario === "poor") assert.match(renderToStaticMarkup(tree), /Не хватает жемчужин: 0,5/);
  }
});

test("unfinished stations expose construction instead of slot purchases in the map and production hub", () => {
  for (const phase of ["unbuilt", "construction", "upgrade"]) {
    hooks.reset(); const calls = [], economy = controller({ act: (...args) => calls.push(args) });
    economy.snapshot.buildings.woodlot = phase === "upgrade" ? 1 : 0;
    if (phase !== "unbuilt") economy.snapshot.jobs = [{ id: "build-woodlot", kind: "construction", targetId: "woodlot", targetLevel: phase === "upgrade" ? 2 : 1,
      startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 60_000).toISOString(), rewards: {}, cost: { coins: 0, items: {} } }];
    assert.equal(render(economy), null, phase);
    for (const entry of ["map", "hub"]) {
      hooks.reset(); const navigations = [];
      function enter() {
        hooks.render();
        return entry === "map" ? TestSlotMenuBody({ economy, onClose() {}, selection: { place: "woodlot", objectId: "woodlot.position", x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 } })
          : TestSlotProduction({ economy, focusId: "woodlot", navigate: (...args) => navigations.push(args) });
      }
      let tree = enter(), nodes = elements(tree);
      assert.equal(nodes.some(node => node.type === WorldProductionSlots), false, `${phase}: ${entry}`);
      const notice = nodes.find(node => node.type === WorldStationSetup);
      assert.ok(notice, `${phase}: ${entry} must lead to construction`);
      const previousDocument = globalThis.document, previousHTMLElement = globalThis.HTMLElement;
      try {
        globalThis.document = { activeElement: null };
        globalThis.HTMLElement = class {};
        notice.props.onOpenConstruction();
      } finally { globalThis.document = previousDocument; globalThis.HTMLElement = previousHTMLElement; }
      if (entry === "map") {
        tree = enter();
        assert.equal(elements(tree).find(node => node.type === WorldUpgradeDialog).props.stationId, "woodlot", "the existing construction dialog opens");
      } else assert.deepEqual(navigations, [["buildings", "woodlot"]]);
      assert.deepEqual(calls, [], "reviewing construction cannot spend pearls or start work");
    }
  }
});

test("both entry points discard confirmation on station or owner changes, including return to the original context", () => {
  for (const entry of ["map", "hub"]) {
    const calls = [], economy = controller({ act: (...args) => calls.push(args) });
    let mountedKey, mountedHooks;
    function enter(stationId = "woodlot") {
      hooks.reset();
      const parent = entry === "map" ? TestSlotMenuBody({ economy, onClose() {}, selection: {
        place: stationId, objectId: `${stationId}.position`, x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 } })
        : TestSlotProduction({ economy, focusId: stationId, navigate() {} });
      const slot = elements(parent).find(node => node.type === WorldProductionSlots);
      assert.ok(slot, `${entry} must expose its actual slots component`);
      // React retains hook state only when a child type and key are unchanged.
      // Read the real parents' keys, then apply that contract to this hook store.
      if (slot.key !== mountedKey) hooks.reset();
      else hooks.restore(mountedHooks);
      mountedKey = slot.key; hooks.render();
      const tree = slot.type(slot.props); mountedHooks = hooks.capture(); return tree;
    }
    click(card(enter(), 2)); assert.ok(buy(enter()), entry);
    assert.equal(buy(enter("garden")), undefined, entry);
    assert.equal(buy(enter("woodlot")), undefined, `${entry}: returning must not revive the old quote`);
    click(card(enter(), 2)); assert.ok(buy(enter()), entry);
    economy.snapshot.ownerPublicId = "OTHER";
    assert.equal(buy(enter()), undefined, entry);
    economy.snapshot.ownerPublicId = "ME";
    assert.equal(buy(enter()), undefined, `${entry}: restoring an owner must not restore their stale confirmation`);
    assert.deepEqual(calls, [], entry);
  }
});

test("a changed snapshot never turns consent for place two into a more expensive place three", () => {
  hooks.reset(); const calls = [], economy = controller({ act: (...args) => calls.push(args) });
  click(card(render(economy), 2)); assert.match(renderToStaticMarkup(render(economy)), /Купить за 100/);
  economy.snapshot.productionSlots.woodlot = 2; economy.snapshot.revision++;
  assert.equal(buy(render(economy)), undefined); assert.deepEqual(calls, []);
  click(card(render(economy), 3)); const tree = render(economy);
  assert.match(renderToStaticMarkup(tree), /Купить за 250/); assert.equal(buy(tree).props.disabled, false);
  click(cancel(tree)); assert.deepEqual(calls, []);
  hooks.reset(); delete economy.snapshot.productionSlots.woodlot;
  click(card(render(economy), 2)); economy.snapshot.catalog.productionSlots.upgrades.find(offer => offer.slots === 2).pricePearls += 100;
  const changedPrice = render(economy);
  assert.match(renderToStaticMarkup(changedPrice), /Купить за 100/);
  assert.match(renderToStaticMarkup(changedPrice), /Цена изменилась/);
  assert.equal(buy(changedPrice).props.disabled, true); click(buy(changedPrice)); assert.deepEqual(calls, []);
});

test("working and ready jobs replace free cards without duplicate work and preserve every legacy result", () => {
  hooks.reset(); const economy = controller();
  economy.snapshot.jobs = [production("first"), production("second", "woodlot", { finishesAt: new Date(now).toISOString() }), production("third"), production("legacy")];
  const html = renderToStaticMarkup(render(economy));
  assert.match(html, /data-production-slot="1" data-state="working"/);
  assert.match(html, /data-production-slot="2" data-state="ready"/);
  assert.match(html, /data-job-countdown="true">2:00/); assert.match(html, /data-item-icon="wood"/);
  assert.doesNotMatch(html, /data-production-activity=/);
  assert.match(html, /Ранее запущенные заказы/);
  for (const id of ["first", "second", "third", "legacy"]) assert.equal((html.match(new RegExp(`data-job-id="${id}"`, "g")) ?? []).length, 1);
  assert.match(html, /Готово к получению/); assert.match(html, /Забрать: Бревно/);
  assert.doesNotMatch(html, /×1|Осталось/);
  assert.equal(economy.snapshot.jobs.length, 4); assert.equal(economy.snapshot.productionSlots.woodlot, undefined);
});

test("slot work retains the server collection sequence, actor lock and storage gate", () => {
  hooks.reset(); const calls = [], economy = controller({ act: (...args) => calls.push(args) });
  const crop = production("crop", "garden", { finishesAt: new Date(now).toISOString() });
  economy.snapshot.jobs = [crop];
  let tree = renderWork(Work, { economy, job: crop, compact: true });
  click(elements(tree).find(node => node.type === "button")); assert.deepEqual(calls, [["start_garden_collection", "crop"]]);
  crop.collection = { startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 8000).toISOString() };
  tree = renderWork(Work, { economy, job: crop, compact: true }); const collecting = elements(tree).find(node => node.type === "button");
  assert.equal(collecting.props.disabled, true); click(collecting); assert.equal(calls.length, 1);
  economy.now += 8000; economy.snapshot.storage.available = 0;
  tree = renderWork(Work, { economy, job: crop, compact: true }); const blocked = elements(tree).find(node => node.type === "button");
  assert.equal(blocked.props.disabled, true); click(blocked); assert.equal(calls.length, 1);
  economy.snapshot.storage.available = 1;
  tree = renderWork(Work, { economy, job: crop, compact: true }); click(elements(tree).find(node => node.type === "button"));
  assert.deepEqual(calls.at(-1), ["claim_job", "crop"]);
  crop.collection = null; let started = 0;
  hooks.setCollection({ jobId: null, phase: "idle", start(id) { assert.equal(id, "crop"); started++; } });
  tree = renderWork(Work, { economy, job: crop, compact: true }); click(elements(tree).find(node => node.type === "button"));
  assert.equal(started, 1); assert.equal(calls.length, 2, "Map collection uses its existing scene controller");
});

test("working cells show their saved products in every manufacturing station", () => {
  for (const [station, rewards] of [["garden", { strawberries: 1 }], ["woodlot", { wood: 1 }], ["workshop", { rope: 1 }], ["dryer", { compote: 1 }], ["kiln", { bricks: 1 }]]) {
    hooks.reset();
    const job = production(`working-${station}`, station, { rewards });
    const economy = controller(); economy.snapshot.jobs = [job];
    const tree = renderWork(ProductionWork, { economy, job, compact: true });
    const html = renderToStaticMarkup(tree);
    for (const itemId of Object.keys(rewards)) assert.match(html, new RegExp(`data-item-icon="${itemId}"`));
    assert.doesNotMatch(html, /data-production-activity=|data-garden-item=|lucide-sprout/);
    const main = elements(tree).find(node => node.props["data-production-control"]);
    assert.equal(main.props.disabled, false);
    assert.match(main.props["aria-label"], /Отменить производство/);
  }
});

test("live countdown preserves seconds at minute and hour boundaries without changing recipe durations", () => {
  for (const [seconds, expected] of [[0, "0:00"], [-5, "0:00"], [0.1, "0:01"], [9, "0:09"], [59, "0:59"], [60, "1:00"], [61, "1:01"], [2699, "44:59"], [2700, "45:00"], [3599, "59:59"], [3600, "1:00:00"], [3601, "1:00:01"], [129601, "36:00:01"]]) {
    assert.equal(worldCountdown(seconds), expected);
  }
  for (const seconds of [NaN, Infinity, -Infinity]) assert.equal(worldCountdown(seconds), "0:00");
  assert.equal(worldDuration(2700), "45 мин");
  assert.equal(worldDuration(3601), "1 ч 1 мин");
});

test("production cells count exact confirmed seconds and switch to claim only at their saved deadline", () => {
  hooks.reset();
  const job = production("timed-food", "dryer", { rewards: { compote: 1 }, finishesAt: new Date(now + 2_700_000).toISOString() });
  const economy = controller(); economy.snapshot.jobs = [job];
  for (const [elapsed, expected] of [[0, "45:00"], [1_000, "44:59"], [2_640_000, "1:00"], [2_641_000, "0:59"], [2_699_999, "0:01"]]) {
    economy.now = now + elapsed;
    const tree = renderWork(ProductionWork, { economy, job, compact: true });
    const timer = elements(tree).find(node => node.props["data-job-countdown"]);
    assert.equal(timer.props.children, expected);
    assert.doesNotMatch(renderToStaticMarkup(tree), /Осталось|×1|Готово к получению/);
  }
  economy.now = Date.parse(job.finishesAt);
  const ready = renderWork(ProductionWork, { economy, job, compact: true });
  assert.equal(elements(ready).find(node => node.props["data-job-countdown"]), undefined);
  assert.match(renderToStaticMarkup(ready), /Готово к получению/);
  assert.equal(job.finishesAt, new Date(now + 2_700_000).toISOString());
});

test("saved batch and mixed result quantities stay explicit while ordinary cells omit one", () => {
  for (const [rewards, expected] of [[{ wood: 1 }, "Бревно"], [{ wood: 7 }, "Бревно ×7"], [{ wood: 1, planks: 3 }, "Бревно ×1 + Доска ×3"]]) {
    hooks.reset(); const job = production("saved-outputs", "workshop", { rewards });
    const economy = controller(); economy.snapshot.jobs = [job];
    const tree = renderWork(ProductionWork, { economy, job, compact: true });
    const control = elements(tree).find(node => node.props["data-production-control"]);
    assert.equal(elements(control).find(node => node.type === "strong").props.children, expected);
    assert.equal(control.props["aria-label"], `Отменить производство: ${expected}`);
  }
});

test("shared and hub job timers retain the real deadline and do not unlock nonproduction claims early", () => {
  for (const entry of [Work, TestSlotJobCard]) for (const kind of ["construction", "exploration"]) {
    hooks.reset(); const calls = [];
    const job = production("other-work", kind === "construction" ? "home" : "forest", { kind, targetLevel: kind === "construction" ? 2 : null,
      rewards: kind === "construction" ? {} : { wood: 2 }, finishesAt: new Date(now + 61_000).toISOString() });
    const economy = controller({ act(...args) { calls.push(args); } }); economy.snapshot.jobs = [job];
    for (const [elapsed, expected] of [[0, "1:01"], [1000, "1:00"], [60_999, "0:01"]]) {
      economy.now = now + elapsed;
      const tree = renderWork(entry, { economy, job, navigate() {} });
      const html = renderToStaticMarkup(tree);
      assert.ok(html.includes(expected)); assert.doesNotMatch(html, /Осталось|Ещё /);
      const claim = elements(tree).find(node => node.type === "button");
      assert.equal(claim.props.disabled, true);
    }
    assert.deepEqual(calls, []);
    economy.now = Date.parse(job.finishesAt);
    const ready = renderWork(entry, { economy, job, navigate() {} });
    assert.equal(Boolean(elements(ready).find(node => node.type === "button").props.disabled), false);
  }
});

test("long saved product names fit the reserved slot frame and keep their full accessible label", async () => {
  hooks.reset();
  const economy = controller();
  economy.snapshot.buildings.kiln = 1;
  const fullName = "Древесный уголь из тщательно высушенных лесных брёвен";
  economy.snapshot.catalog.items.find(item => item.id === "charcoal").name = fullName;
  const job = production("long-charcoal", "kiln", { recipeId: "make_charcoal", rewards: { charcoal: 1 } });
  economy.snapshot.jobs = [job];
  const tree = renderWork(ProductionWork, { economy, job, compact: true });
  const control = elements(tree).find(node => node.props["data-production-control"]);
  assert.equal(control.props["aria-label"], `Отменить производство: ${fullName}`);
  assert.match(renderToStaticMarkup(tree), /data-item-icon="charcoal"/);
  assert.equal(elements(control).find(node => node.type === "strong").props.children, fullName);
  assert.equal(elements(control).filter(node => node.props["data-production-action"]).length, 1);

  const css = await readFile(new URL("../features/economy/ui/production/world-production-slots.module.css", import.meta.url), "utf8");
  assert.match(css, /\.slots\.slots \.slot\s*\{[^}]*height: 118px;[^}]*min-height: 118px;/);
  assert.match(css, /button\[data-production-control\]\s*\{[^}]*grid-template-rows:[^}]*height: 84px;[^}]*min-height: 0;/);
  assert.match(css, /button\[data-production-control\] > strong\s*\{[^}]*-webkit-line-clamp: 2;/);
  assert.match(css, /\.job:has\(\[data-production-blocking\]\)\s*\{\s*height: auto;/, "only persistent blocking messages and pantry controls expand the cell");
});

test("cancellation uses one compact action row and describes the exact stored refund accessibly", () => {
  hooks.reset(); const calls = [];
  const job = production("paid", "workshop", { recipeId: "make_rope", rewards: { rope: 1 }, cost: { coins: 17, items: { fiber: 3, wood: 2 } }, catalogVersion: 1 });
  const economy = controller({ act(...args) { calls.push(args); return true; } }); economy.snapshot.jobs = [job];
  // Changing a current recipe never changes the refund for a job already paid.
  economy.snapshot.catalog.recipes.find(recipe => recipe.id === "make_rope").cost = { coins: 999, items: { stone: 44 } };
  const renderCell = () => renderWork(ProductionWork, { economy, job, compact: true });
  const main = tree => elements(tree).find(node => node.props["data-production-control"]);
  click(main(renderCell())); assert.deepEqual(calls, []);
  const armed = renderCell(), html = renderToStaticMarkup(armed);
  assert.match(html, /Удалить\?/); assert.match(html, /5 с/);
  assert.equal(main(armed).props.title, "Вернётся: 17 монет, Растительное волокно ×3, Бревно ×2");
  assert.match(html, /title="Вернётся:/); assert.match(html, /aria-describedby="production-slot-confirmation"/);
  assert.doesNotMatch(html, /data-production-dismiss|Оставить|data-item-icon="coins"|data-item-icon="fiber"|data-item-icon="wood"/);
  assert.doesNotMatch(html, /999|×44|role="dialog"/);
  assert.equal(elements(main(armed)).filter(node => node.type === "button").length, 1, "cell buttons must not be nested");
  const confirmationButton = main(armed); click(confirmationButton); click(confirmationButton);
  assert.deepEqual(calls, [["cancel_production", "paid"]]);
  assert.equal(main(renderCell()).props.disabled, true, "the gap before busy publication also blocks repeats");
});

test("five-second confirmation counts down and expires without issuing any command", () => withMonotonicClock(clock => {
  hooks.reset(); const calls = [], job = production("countdown"), economy = controller({ act: (...args) => { calls.push(args); return true; } });
  economy.snapshot.jobs = [job];
  const renderCell = () => renderWork(ProductionWork, { economy, job, compact: true });
  const main = tree => elements(tree).find(node => node.props["data-production-control"]);
  click(main(renderCell())); assert.match(renderToStaticMarkup(renderCell()), /Удалить\?.*5 с/);
  hooks.flush(); assert.equal(clock.intervals.size, 1);
  clock.advance(1000); assert.match(renderToStaticMarkup(renderCell()), /Удалить\?.*4 с/);
  clock.advance(4000); const expired = renderCell(); hooks.flush();
  assert.equal(clock.intervals.size, 0); assert.doesNotMatch(renderToStaticMarkup(expired), /Удалить\?/); assert.deepEqual(calls, []);
  click(main(expired)); assert.match(renderToStaticMarkup(renderCell()), /Удалить\?.*5 с/); assert.deepEqual(calls, []);
}));

test("the second click must precede the monotonic deadline even if timer callbacks are delayed", () => {
  for (const elapsed of [4999, 5000, 7000]) withMonotonicClock(clock => {
    hooks.reset(); const calls = [], job = production(`deadline-${elapsed}`), economy = controller({ act: (...args) => { calls.push(args); return true; } });
    economy.snapshot.jobs = [job];
    const renderCell = () => renderWork(ProductionWork, { economy, job });
    const main = tree => elements(tree).find(node => node.props["data-production-control"]);
    click(main(renderCell())); const armedButton = main(renderCell()); hooks.flush();
    clock.advance(elapsed, false); click(armedButton);
    assert.deepEqual(calls, elapsed < 5000 ? [["cancel_production", job.id]] : [], `deadline ${elapsed}`);
    if (elapsed >= 5000) {
      assert.match(renderToStaticMarkup(renderCell()), /Удалить\?.*5 с/, "a late click only opens new consent");
      clock.advance(4999, false); click(main(renderCell())); assert.deepEqual(calls, [["cancel_production", job.id]]);
    }
  });
});

test("fast repeated clicks send one cancellation and never rearm a submitted cell", () => withMonotonicClock(() => {
  hooks.reset(); const calls = [], job = production("rapid-clicks"), economy = controller({ act: (...args) => { calls.push(args); return true; } });
  economy.snapshot.jobs = [job];
  const renderCell = () => renderWork(ProductionWork, { economy, job });
  const control = elements(renderCell()).find(node => node.props["data-production-control"]);
  click(control); click(control); click(control); click(control);
  assert.deepEqual(calls, [["cancel_production", job.id]]);
  const submitted = renderCell(); assert.doesNotMatch(renderToStaticMarkup(submitted), /Удалить\?/);
  assert.equal(elements(submitted).find(node => node.props["data-production-control"]).props.disabled, true);
}));

test("arming and expiry retain the same visible product, timer, action row and slot structure", async () => {
  withMonotonicClock(clock => {
    hooks.reset(); const job = production("stable-layout", "workshop", { rewards: { rope: 1 }, cost: { coins: 17, items: { fiber: 3 } } }), economy = controller(); economy.snapshot.jobs = [job];
    const renderCell = () => renderWork(ProductionWork, { economy, job, compact: true });
    const original = renderCell(), control = elements(original).find(node => node.props["data-production-control"]);
    const visibleShape = tree => elements(tree).filter(node => typeof node.type === "string" && !node.props.id).map(node => [node.type, node.props["data-production-action"] ?? null]);
    const before = visibleShape(original);
    click(control); const armed = renderCell();
    assert.deepEqual(visibleShape(armed), [...before.slice(0, -1), ["span", null], before.at(-1)], "only the countdown is added within the existing action line");
    assert.equal(Children.toArray(original.props.children).length, Children.toArray(armed.props.children).length);
    assert.equal(elements(armed).filter(node => node.type === "button").length, 1);
    assert.equal(elements(armed).filter(node => node.props["data-production-action"]).length, 1);
    assert.match(renderToStaticMarkup(armed), /data-item-icon="rope"/); assert.match(renderToStaticMarkup(armed), /data-job-countdown="true">2:00/);
    hooks.flush(); clock.advance(5000); const expired = renderCell(); assert.deepEqual(visibleShape(expired), before);
  });
  const css = await readFile(new URL("../features/economy/ui/production/production-work.module.css", import.meta.url), "utf8");
  assert.match(css, /\.actionLine\s*\{[^}]*flex: 0 0 26px;[^}]*height: 26px;/);
  assert.match(css, /\[data-confirm-cancel\][^}]*text-decoration: line-through/);
  assert.doesNotMatch(css, /\.refund|\.dismiss/);
});

test("escape, leaving the cell, clicking outside and hiding the page discard consent without cancelling", () => {
  for (const method of ["escape", "blur", "outside", "background", "pagehide"]) {
    hooks.reset(); const calls = [], job = production(`dismiss-${method}`), economy = controller({ act: (...args) => { calls.push(args); return true; } });
    economy.snapshot.jobs = [job];
    const listeners = new Map(), previousDocument = globalThis.document, previousWindow = globalThis.window;
    if (["outside", "background", "pagehide"].includes(method)) {
      globalThis.document = { hidden: false, addEventListener(name, listener) { listeners.set(name, listener); }, removeEventListener(name) { listeners.delete(name); } };
      globalThis.window = { addEventListener(name, listener) { listeners.set(name, listener); }, removeEventListener(name) { listeners.delete(name); } };
    }
    try {
      const renderCell = () => renderWork(ProductionWork, { economy, job });
      click(elements(renderCell()).find(node => node.props["data-production-control"])); const armed = renderCell();
      if (method === "escape") armed.props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
      if (method === "blur") armed.props.onBlurCapture({ currentTarget: { contains: () => false }, relatedTarget: null });
      if (method === "outside") { armed.props.ref.current = { contains: () => false }; hooks.flush(); listeners.get("pointerdown")({ target: {} }); }
      if (method === "background") { hooks.flush(); globalThis.document.hidden = true; listeners.get("visibilitychange")(); }
      if (method === "pagehide") { hooks.flush(); listeners.get("pagehide")(); }
      assert.doesNotMatch(renderToStaticMarkup(renderCell()), /Удалить\?/);
      if (["outside", "background", "pagehide"].includes(method)) assert.equal(listeners.size, 0, "dismissal removes every page listener");
      click(elements(renderCell()).find(node => node.props["data-production-control"])); assert.deepEqual(calls, [], method);
    } finally { hooks.reset(); globalThis.document = previousDocument; globalThis.window = previousWindow; }
  }
});

test("owner, revision and job changes reset inline cancellation rather than reusing consent", () => {
  for (const change of ["owner", "revision", "job", "ready"]) {
    hooks.reset(); const calls = [], first = production(`context-${change}`), economy = controller({ act: (...args) => { calls.push(args); return true; } });
    let job = first; economy.snapshot.jobs = [job];
    const renderCell = () => renderWork(ProductionWork, { economy, job });
    click(elements(renderCell()).find(node => node.props["data-production-control"])); const consent = renderCell(); assert.match(renderToStaticMarkup(consent), /Удалить\?/);
    if (change === "owner") economy.snapshot.ownerPublicId = "OTHER";
    if (change === "revision") economy.snapshot.revision++;
    if (change === "job") { job = production("replacement"); economy.snapshot.jobs = [job]; }
    if (change === "ready") economy.now = Date.parse(job.finishesAt);
    if (["owner", "revision"].includes(change)) { click(elements(consent).find(node => node.props["data-production-control"])); assert.deepEqual(calls, [], "a callback captured before a context change cannot reuse consent"); }
    const changed = renderCell(); assert.doesNotMatch(renderToStaticMarkup(changed), /Удалить\?/);
    click(elements(changed).find(node => node.props["data-production-control"]));
    assert.deepEqual(calls, change === "ready" ? [["claim_job", job.id]] : [], change);
    if (change === "owner") { economy.snapshot.ownerPublicId = "ME"; assert.doesNotMatch(renderToStaticMarkup(renderCell()), /Удалить\?/); }
  }
});

test("cancellation preflight blocks both initial and armed clicks when state becomes unsafe", () => {
  for (const flag of ["busy", "uncertain", "cooldown", "storage", "collected", "ready", "unsupported"]) {
    hooks.reset(); const calls = [], job = production(`guard-${flag}`, "workshop", { rewards: { rope: 1 }, cost: { coins: 0, items: { fiber: 3 } } });
    const economy = controller({ act: (...args) => { calls.push(args); return true; } }); economy.snapshot.jobs = [job];
    const renderCell = () => renderWork(ProductionWork, { economy, job });
    click(elements(renderCell()).find(node => node.props["data-production-control"])); const armed = renderCell();
    if (flag === "busy") economy.busy = true;
    if (flag === "uncertain") economy.uncertain = true;
    if (flag === "cooldown") economy.retryAt = now + 1000;
    if (flag === "storage") economy.snapshot.storage.available = 2;
    if (flag === "collected") job.collection = { kind: "berry_harvest", seconds: 8, startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 8000).toISOString() };
    if (flag === "ready") economy.now = Date.parse(job.finishesAt);
    if (flag === "unsupported") job.targetId = "home";
    click(elements(armed).find(node => node.props["data-production-control"]));
    assert.deepEqual(calls, [], `even the handler already obtained before ${flag} rechecks the guard`);
    if (!["ready", "collected"].includes(flag)) assert.equal(elements(renderCell()).find(node => node.props["data-production-control"]).props.disabled, true);
    if (flag === "storage") assert.match(renderToStaticMarkup(renderCell()), /Освободите 1 мест для возврата материалов/);
  }
});

test("a refused cancellation returns to a usable cell with explicit feedback", () => {
  hooks.reset(); const calls = [], job = production("refused"), economy = controller({ act: (...args) => { calls.push(args); return false; } }); economy.snapshot.jobs = [job];
  const renderCell = () => renderWork(ProductionWork, { economy, job });
  const main = tree => elements(tree).find(node => node.props["data-production-control"]);
  click(main(renderCell())); click(main(renderCell())); const retryable = renderCell();
  assert.deepEqual(calls, [["cancel_production", "refused"]]); assert.equal(main(retryable).props.disabled, false);
  assert.match(renderToStaticMarkup(retryable), /Отмена не отправлена/); assert.doesNotMatch(renderToStaticMarkup(retryable), /Отменяется/);
  click(main(retryable)); assert.equal(calls.length, 1); click(main(renderCell())); assert.equal(calls.length, 2);
});

test("a definitive failed cancellation can be retried after an unchanged-revision refresh", () => {
  hooks.reset(); const calls = [], job = production("failed-response"), economy = controller({ act: (...args) => { calls.push(args); return true; } }); economy.snapshot.jobs = [job];
  const renderCell = () => renderWork(ProductionWork, { economy, job });
  const main = tree => elements(tree).find(node => node.props["data-production-control"]);
  click(main(renderCell())); click(main(renderCell())); assert.equal(main(renderCell()).props.disabled, true);
  economy.busy = true; renderCell();
  economy.busy = false; economy.error = "Server rejected cancellation"; renderCell(); hooks.flush();
  economy.error = null; const recovered = renderCell();
  assert.equal(economy.snapshot.revision, 2); assert.equal(main(recovered).props.disabled, false);
  assert.doesNotMatch(renderToStaticMarkup(recovered), /Отменяется/);
  click(main(recovered)); assert.equal(calls.length, 1); click(main(renderCell())); assert.equal(calls.length, 2);
});

test("an uncertain cancellation keeps receipt recovery in control and never sends a new cancellation", () => {
  hooks.reset(); const calls = [], job = production("lost-response"), economy = controller({ act: (...args) => { calls.push(args); return true; } }); economy.snapshot.jobs = [job];
  const renderCell = () => renderWork(ProductionWork, { economy, job });
  const main = tree => elements(tree).find(node => node.props["data-production-control"]);
  click(main(renderCell())); click(main(renderCell()));
  economy.uncertain = true; economy.error = "Response lost"; const unknown = renderCell(); hooks.flush();
  assert.equal(main(unknown).props.disabled, true); click(main(unknown)); assert.equal(calls.length, 1);
  economy.error = null; const recovering = renderCell(); assert.equal(main(recovering).props.disabled, true); click(main(recovering)); assert.equal(calls.length, 1);
});

test("a ready-cell command refusal explains that obtaining the product was not sent", () => {
  hooks.reset(); const job = production("claim-refused", "woodlot", { finishesAt: new Date(now).toISOString() });
  const economy = controller({ act: () => false }); economy.snapshot.jobs = [job];
  const renderCell = () => renderWork(ProductionWork, { economy, job });
  click(elements(renderCell()).find(node => node.props["data-production-control"]));
  assert.match(renderToStaticMarkup(renderCell()), /Действие не отправлено/);
});

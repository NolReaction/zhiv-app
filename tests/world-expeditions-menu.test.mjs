import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-expedition-ui-vite-${process.pid}`, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { WorldExpeditionsMenu, WorldExpeditionSector, ExpeditionRouteDetails, ActiveExpedition, expeditionCancellationKey, expeditionSector, expeditionSectors } = await vite.ssrLoadModule("/features/economy/ui/expeditions/world-expeditions-menu.tsx");
const { WorldTacklePicker, fishingTackleOptions } = await vite.ssrLoadModule("/features/economy/ui/fishing/world-tackle-picker.tsx");
const { getAudioRuntime } = await vite.ssrLoadModule("/features/audio/runtime/audio-service.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { mealDuration } = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const { worldDuration } = await vite.ssrLoadModule("/features/economy/ui/shared/world-stations.ts");
after(() => vite.close());

const now = Date.parse("2026-10-03T12:00:00Z");
function snapshot(overrides = {}) {
  const state = { ownerPublicId: "ME", revision: 2, serverTime: new Date(now).toISOString(), wallet: { coins: 0, pearls: 0 }, inventory: {}, buildings: { home: 1, warehouse: 1 }, jobs: [], completedExplorations: 0,
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: structuredClone(economyCatalog), ...overrides };
  return { ...state, storage: overrides.storage ?? economyStorage(state) };
}
function controller(overrides = {}) {
  return { snapshot: snapshot(), market: null, marketError: null, busy: false, uncertain: false, error: null, notice: "", now, retryAt: 0, act() {}, actMarket() {}, refresh() {}, refreshMarket() {}, retry() {}, ...overrides };
}
function job(overrides = {}) {
  return { id: "da818fb4-6c9e-4b42-9b78-60669b234f0a", kind: "exploration", targetId: "forest", recipeId: null, targetLevel: null, startedAt: new Date(now - 1_000).toISOString(), finishesAt: new Date(now + 29_000).toISOString(), rewards: { wood: 5, stone: 3, fiber: 4 }, cost: { coins: 0, items: {} }, catalogVersion: 2, ...overrides };
}
function render(economy = controller(), props = {}) {
  return renderToStaticMarkup(createElement(WorldExpeditionsMenu, { economy, onOpenPantry() {}, ...props }));
}
function renderSector(sectorId, economy = controller(), props = {}) {
  return renderToStaticMarkup(createElement(WorldExpeditionSector, { sectorId, economy, state: economy.snapshot, selectedRoute: null, exploring: economy.snapshot.jobs.some(job => job.kind === "exploration" && job.actorId !== "miner"), onSelectRoute() {}, onOpenPantry() {}, ...props }));
}
function renderPreparation(id, economy = controller(), props = {}) {
  return renderSector(expeditionSector(id), economy, { selectedRoute: id, ...props });
}
function route(html, id) {
  const found = new RegExp(`<(button|section)\\b[^>]*data-route="${id}"[^>]*>`).exec(html);
  assert.ok(found, `Missing route: ${id}`);
  const start = found.index, tag = found[1];
  let depth = 0;
  for (const match of html.slice(start).matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, "g"))) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, start + match.index + match[0].length);
  }
  assert.fail(`Unclosed route: ${id}`);
}
function button(html, label) {
  const found = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ attributes: match[1], text: match[2].replace(/<[^>]*>/g, "") })).find(entry => entry.attributes.includes(`aria-label="${label}"`) || entry.text.includes(label));
  assert.ok(found, `Missing button: ${label}`);
  return found;
}
const disabled = value => /\bdisabled=/.test(value.attributes);

test("pending hero food quotes the same speed-adjusted time in route list, preparation and departure", () => {
  for (const id of ["forest", "shore"]) {
    const state = snapshot({ inventory: { wood: 20, dried_berries: 20 }, food: { heroMeal: null, builderMeal: "grilled_fish" } });
    const selected = state.catalog.explorations.find(entry => entry.id === id);
    selected.seconds = 7200;
    const economy = controller({ snapshot: state });
    assert.ok(button(renderPreparation(id, economy), `Отправиться: ${selected.name}`).text.includes("2 ч"), "builder food does not alter the hero's trip");
    state.food.heroMeal = "hearty_fish";
    const speedBps = state.catalog.food.meals.find(meal => meal.itemId === "hearty_fish").heroSpeedBps;
    const before = structuredClone(state), expected = worldDuration(mealDuration(selected.seconds, speedBps));
    assert.notEqual(expected, worldDuration(Math.ceil(selected.seconds * (1 - speedBps / 10_000))), "extra speed divides duration rather than subtracting the same percentage");
    const list = route(renderSector(expeditionSector(id), economy), id);
    assert.ok(list.includes(expected));
    const preparation = renderPreparation(id, economy);
    assert.ok(button(preparation, `Отправиться: ${selected.name}`).text.includes(expected));
    const heading = preparation.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)?.[1];
    assert.ok(heading?.includes(expected), "preparation heading and departure action agree");
    assert.match(preparation, new RegExp(`скорость \\+${speedBps / 100}%`, "i"));
    assert.ok(preparation.indexOf('data-meal-boost="hero"') > preparation.indexOf("</header>"), "food is an explicit choice below the route timer");
    assert.doesNotMatch(heading, /data-meal-boost=/);
    assert.ok(button(renderPreparation(id, economy), `Отправиться: ${selected.name}`).text.includes(expected));
    assert.deepEqual(state, before, "repeated previews must preserve the pending meal and original route time");
  }
});

test("travel starts with two decorated hero activities and no mine or premature route form", () => {
  const html = render(controller(), { onUpgradeQuarry() {} });
  assert.match(html, /role="group" aria-label="Занятия леса"/);
  for (const id of ["forest", "shore"]) {
    assert.match(html, new RegExp(`data-sector-select="${id}"`));
    assert.match(html, new RegExp(`data-activity-art="${id}"`));
  }
  assert.match(html, /За припасами/); assert.match(html, /На рыбалку/);
  assert.doesNotMatch(html, /data-sector-select="caves"|data-activity-art="caves"|Открыть шахту|шахт[аеуы]/i);
  assert.doesNotMatch(html, /data-route=|<select\b|aria-label="Отправиться:/);
  const supplies = renderSector("forest");
  assert.equal([...supplies.matchAll(/<button\b[^>]*data-route=/g)].length, 2);
  assert.match(supplies, /Доступные маршруты/); assert.doesNotMatch(supplies, /Нужно подготовиться|data-locked/);
  assert.equal(disabled(button(route(supplies, "forest"), "Подготовиться: Лесная разведка")), false);
});

test("every catalog route belongs to exactly one sector and keeps its actual findings", () => {
  const expected = { forest: ["forest", "forest_camp", "old_woodland", "coastal_deposits", "uplands", "far_bank_path", "far_bank_grove", "ancient_ruins"], shore: ["shore", "shore_camp"], caves: ["cave", "deep_cave", "abandoned_quarry", "quarry_stone", "quarry_stone_overnight", "quarry_ore", "quarry_clay", "quarry_sand", "quarry_shift", "quarry_deep_face", "quarry_supply", "quarry_stone_hour", "quarry_clay_hour", "quarry_clay_overnight", "quarry_sand_hour", "quarry_sand_overnight", "quarry_ore_hour", "quarry_ore_overnight"] };
  const seen = [];
  for (const sector of expeditionSectors) {
    const state = snapshot({ buildings: Object.fromEntries(economyCatalog.buildings.map(building => [building.id, 5])) });
    // Each route is inspected at its minimum progression, including older mining
    // shifts that disappear when a better shift opens.
    const ids = [];
    for (const entry of economyCatalog.explorations.filter(route => expeditionSector(route.id) === sector.id)) {
      const routeState = snapshot({ ...state, buildings: { ...state.buildings, quarry: entry.requiredBuildings.quarry ?? 5 } });
      const content = renderSector(sector.id, controller({ snapshot: routeState }));
      assert.match(content, new RegExp(`data-route="${entry.id}"`));
      ids.push(entry.id);
    }
    const html = renderSector(sector.id, controller({ snapshot: state }));
    const visibleIds = [...html.matchAll(/data-route="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(ids.sort(), expected[sector.id].sort());
    seen.push(...ids);
    for (const id of visibleIds) {
      const entry = economyCatalog.explorations.find(route => route.id === id);
      assert.equal(expeditionSector(id), sector.id);
      const content = route(html, id);
      assert.match(content, /<button\b/);
      assert.match(content, /aria-label="Подготовиться:/);
      assert.doesNotMatch(content, /<details\b|<select\b/);
      for (const [itemId, count] of Object.entries(entry.rewards)) {
        const name = itemId === "fish" && economyCatalog.fishing.routeIds.includes(id)
          ? "Рыбный улов" : economyCatalog.items.find(item => item.id === itemId).name;
        assert.ok(content.includes(name));
        if (count !== 1) assert.ok(content.includes(`×${count}`));
        else assert.doesNotMatch(content, /×1(?!\d)/, "one unit is named without redundant ×1");
      }
      assert.ok(!content.includes(entry.description), "descriptive prose should not obscure route choices");
    }
  }
  assert.deepEqual(seen.sort(), economyCatalog.explorations.map(route => route.id).sort());
});

test("the fisherman's shortcut opens the shore sector without changing route conditions", () => {
  const html = render(controller(), { initialSector: "shore" });
  assert.match(html, /Все занятия/);
  assert.doesNotMatch(html, /data-sector-select=/);
  assert.match(html, /data-sector="shore"/);
  assert.doesNotMatch(html, /data-sector="forest"/);
  const shore = route(html, "shore");
  assert.match(shore, /Рыбалка на берегу/);
  assert.equal(disabled(button(shore, "Подготовиться: Рыбалка на берегу")), false);
});

test("selected route replaces the list with one preparation screen and a return action", () => {
  const html = renderPreparation("shore");
  assert.match(route(html, "shore"), /data-route-preparation="true"/);
  assert.doesNotMatch(html, /data-route="shore_camp"|data-route="coastal_deposits"|Подготовиться:/);
  assert.doesNotMatch(html, /<select\b/);
  for (const kind of ["rod", "hook", "bait"]) assert.match(html, new RegExp(`data-tackle-slot="${kind}"`));
  assert.equal([...html.matchAll(/aria-label="Отправиться:/g)].length, 1);
  assert.equal(disabled(button(html, "Все маршруты")), false);
  assert.match(html, /Улов за одну вылазку/);
  assert.match(route(renderSector("shore"), "shore_camp"), /data-compact="true"/);
});

test("progression-locked routes and stale selections stay hidden until all buildings are ready", () => {
  const state = snapshot();
  for (const id of ["old_woodland", "coastal_deposits", "uplands"]) {
    const html = renderPreparation(id, controller({ snapshot: state }));
    assert.doesNotMatch(html, new RegExp(`data-route="${id}"|data-route-preparation="true"|aria-label="Отправиться:`));
  }
  state.buildings = { home: 3, warehouse: 1, dryer: 1, workshop: 1 };
  assert.doesNotMatch(renderSector("forest", controller({ snapshot: state })), /data-route="old_woodland"/);
  state.buildings.workshop = 2;
  const open = renderPreparation("old_woodland", controller({ snapshot: state }));
  assert.match(open, /data-route-preparation="true"/);
  assert.equal(disabled(button(open, "Отправиться")), true, "opened routes still show missing provisions");
});

test("cave preparation explains the unbuilt quarry and guards departure until it is completed", () => {
  for (const id of ["cave", "deep_cave"]) {
    const state = snapshot({ buildings: { home: 3, warehouse: 5, quarry: 0 },
      inventory: { dried_berries: 1, smoked_fish: 1 } });
    const locked = sectorView("caves", state, {}, { selectedRoute: id, onNavigateStation() {} });
    assert.match(locked.html, new RegExp(`data-route="${id}"`));
    assert.match(locked.html, /Каменоломня · нужен ур. 1/);
    assert.equal(locked.depart(id).props.disabled, true);
    locked.depart(id).props.onClick();
    assert.deepEqual(locked.calls, []);
    state.buildings.quarry = 1;
    const open = sectorView("caves", state, {}, { selectedRoute: id });
    assert.equal(open.depart(id).props.disabled, false);
    open.depart(id).props.onClick();
    assert.equal(open.calls.length, 1);
    state.jobs = [job({ kind: "construction", targetId: "quarry", targetLevel: 2, rewards: {} })];
    const upgrading = sectorView("caves", state, {}, { selectedRoute: id });
    assert.equal(upgrading.depart(id).props.disabled, true);
    upgrading.depart(id).props.onClick();
    assert.deepEqual(upgrading.calls, []);
  }
});

test("deep routes use actual consumable amounts, and missing provisions block departure", () => {
  const state = snapshot({ buildings: { home: 3, warehouse: 1, quarry: 1 }, inventory: { dried_berries: 1 } });
  let html = route(renderPreparation("deep_cave", controller({ snapshot: state })), "deep_cave");
  assert.match(html, /Припасы для вылазки|Для добычи/);
  assert.match(html, /Не хватает припасов/);
  assert.equal(disabled(button(html, "Начать добычу")), true);
  html = route(renderPreparation("deep_cave", controller({ snapshot: snapshot({ ...state, inventory: { dried_berries: 1, smoked_fish: 1 } }) })), "deep_cave");
  assert.equal(disabled(button(html, "Начать добычу")), false);
});

test("departure compares reward size with total capacity; a full pantry can be cleared before return", () => {
  let state = snapshot({ storage: { capacity: 10, available: 10, used: 0, reserved: 0, overflow: 0 } });
  let html = route(renderPreparation("forest", controller({ snapshot: state })), "forest");
  assert.equal(disabled(button(html, "Отправиться")), true);
  assert.match(html, /Находки займут 12 мест, вместимость - 10/);
  assert.equal(disabled(button(html, "Расширить кладовую")), false);
  state = snapshot({ storage: { capacity: 200, available: 0, used: 170, reserved: 30, overflow: 0 } });
  html = route(renderPreparation("forest", controller({ snapshot: state })), "forest");
  assert.equal(disabled(button(html, "Отправиться")), false);
  assert.match(html, /свободно 0/);
});

test("ongoing exploration shows real progress and seconds, and exposes no second departure", () => {
  const html = render(controller({ snapshot: snapshot({ jobs: [job()] }) }));
  assert.match(html, /Текущая вылазка: Лесная разведка/);
  assert.match(html, /0:29/);
  assert.doesNotMatch(html, /Ещё 29|Осталось/);
  assert.match(html, /<progress[^>]*value="0\.033/);
  assert.equal(disabled(button(html, "Забрать находки: Лесная разведка")), true);
  assert.doesNotMatch(html, /aria-label="Отправиться:/);
  assert.ok(html.indexOf("Текущая вылазка") < html.indexOf("Занятия леса"));
});

test("an active route from another sector stays above the sector picker", () => {
  const html = render(controller({ snapshot: snapshot({ jobs: [job({ targetId: "shore", rewards: { fish: 1 } })] }) }));
  assert.match(html, /Текущая вылазка: Рыбалка на берегу/);
  assert.match(html, /data-sector-select="forest"/);
  assert.ok(html.indexOf("Текущая вылазка") < html.indexOf("Занятия леса"));
  assert.doesNotMatch(html, /aria-label="Отправиться:/);
});

test("ready finds honor available space including market reservations and retain an accessible pantry action", () => {
  const ready = job({ finishesAt: new Date(now).toISOString() });
  let html = render(controller({ snapshot: snapshot({ jobs: [ready], storage: { capacity: 200, used: 180, reserved: 15, available: 5, overflow: 0 } }) }));
  assert.match(html, /Мохлик вернулся/);
  assert.match(html, /Нужно освободить 7 мест/);
  assert.equal(disabled(button(html, "Забрать находки: Лесная разведка")), true);
  assert.equal(disabled(button(html, "Открыть кладовую")), false);
  html = render(controller({ snapshot: snapshot({ jobs: [ready] }) }));
  assert.equal(disabled(button(html, "Забрать находки: Лесная разведка")), false);
});

test("construction and production do not hide exploration or occupy the explorer", () => {
  const html = renderPreparation("forest", controller({ snapshot: snapshot({ jobs: [job({ kind: "construction", targetId: "home", rewards: {}, targetLevel: 2 }), job({ kind: "production", targetId: "garden", recipeId: "grow_berries", rewards: { berries: 6 } })] }) }));
  assert.doesNotMatch(html, /Текущая вылазка|Мохлик занят|Мохлик в пути/);
  assert.equal(disabled(button(route(html, "forest"), "Отправиться")), false);
});

test("legacy quarry work blocks Mochlik departures and leaves the independent miner available", () => {
  for (const finished of [false, true]) {
    const saved = job({ kind: "production", targetId: "quarry", recipeId: "quarry_stone", finishesAt: new Date(now + (finished ? 0 : 30_000)).toISOString() });
    const economy = controller({ snapshot: snapshot({ jobs: [saved], buildings: { home: 3, warehouse: 1, quarry: 1 } }) });
    const html = render(economy, { onNavigateStation() {} });
    assert.doesNotMatch(html, /шахт|каменоломн|data-sector-select="caves"/i);
    for (const [sector, id] of [["forest", "forest"], ["shore", "shore"]]) {
      const blocked = sectorView(sector, economy.snapshot, {}, { selectedRoute: id });
      assert.equal(blocked.depart(id), undefined);
      assert.match(blocked.html, /Завершите предыдущую работу Мохлика на карте/);
      assert.doesNotMatch(blocked.html, /шахт|каменоломн/i);
      assert.deepEqual(blocked.calls, []);
    }
    const mine = sectorView("caves", { ...economy.snapshot, buildings: { ...economy.snapshot.buildings, quarry: 2 } }, {}, { selectedRoute: "quarry_clay" });
    assert.equal(mine.depart("quarry_clay").props.disabled, false);
    mine.depart("quarry_clay").props.onClick();
    assert.deepEqual(mine.calls, [["start_exploration", "quarry_clay", 1, 0]]);
    assert.doesNotMatch(html, /Можно отправиться/);
  }
});

test("general travel ignores old mine selections and leaves quarry content in its dedicated menu", () => {
  for (const buildings of [{ home: 1, quarry: 0, warehouse: 1 }, { home: 3, quarry: 2, warehouse: 1 }]) {
    let tree, navigated = 0, upgraded = 0;
    const economy = controller({ snapshot: snapshot({ buildings }) });
    function Probe() {
      tree = WorldExpeditionsMenu({ economy, initialSector: "caves", onOpenPantry() {},
        onNavigateStation() { navigated++; }, onUpgradeQuarry() { upgraded++; } });
      return tree;
    }
    const html = renderToStaticMarkup(createElement(Probe));
    assert.match(html, /Занятия леса|За припасами|На рыбалку/);
    assert.doesNotMatch(html, /data-sector="caves"|data-sector-select="caves"|шахт|каменоломн|data-route=/i);
    const sectors = [];
    function walk(element) {
      if (!isValidElement(element)) return;
      if (element.props["data-sector-select"]) sectors.push(element);
      Children.forEach(element.props.children, walk);
    }
    walk(tree);
    assert.deepEqual(sectors.map(element => element.props["data-sector-select"]), ["forest", "shore"]);
    for (const element of sectors) element.props.onClick();
    assert.equal(navigated, 0);
    assert.equal(upgraded, 0, "the hero chooser cannot restore or enter a mine");
    const embedded = render(economy, { embeddedCaves: true });
    assert.match(embedded, /data-sector="caves"|data-independent-mining/);
    assert.doesNotMatch(embedded, /Секторы вылазок|Обустройство шахты|data-sector="forest"|data-sector="shore"|data-sector-select=/);
  }
});

test("running and ready mining jobs stay out of general travel while saved cave trips remain claimable in the quarry", () => {
  for (const finished of [false, true]) {
    const finishesAt = new Date(now + (finished ? 0 : 30_000)).toISOString();
    const mining = [
      job({ id: "miner", targetId: "quarry_stone", actorId: "miner", rewards: { stone: 1 }, finishesAt }),
      job({ id: "legacy-cave", targetId: "cave", rewards: { stone: 12 }, finishesAt }),
      job({ id: "legacy-production", kind: "production", targetId: "quarry", recipeId: "quarry_stone", finishesAt }),
      job({ id: "construction", kind: "construction", targetId: "quarry", targetLevel: 3, rewards: {}, finishesAt }),
    ];
    const economy = controller({ snapshot: snapshot({ buildings: { home: 3, quarry: 2, warehouse: 1 }, jobs: mining }) });
    const html = render(economy);
    assert.doesNotMatch(html, /Текущая добыча|Текущая вылазка|Шахта работает|Мохлик вернулся|Обустройство шахты|шахт|каменоломн/i);
    assert.equal(render(economy, { activeOnly: true }), "", "a mining-only snapshot has no hero trip panel");
    const embedded = render(economy, { embeddedCaves: true });
    assert.match(embedded, /Текущая добыча: Добыть камень/);
    assert.match(embedded, /Текущая вылазка: Вход в пещеру/);
    assert.match(embedded, /Забрать находки: Добыть камень|Забрать находки: Вход в пещеру/);
    assert.match(embedded, /Остановить добычу|Отказаться от находок/);
    assert.doesNotMatch(embedded, /data-sector-select=/);
    const hero = job({ id: "hero", finishesAt });
    const withHero = render(controller({ snapshot: snapshot({ jobs: [...mining, hero] }) }));
    assert.match(withHero, /Текущая вылазка: Лесная разведка/);
    assert.doesNotMatch(withHero, /Текущая добыча|Вход в пещеру|Обустройство шахты|data-sector-select="caves"/);
  }
});

test("busy, uncertain and cooldown states prevent both spending and reward claims", () => {
  for (const flags of [{ busy: true }, { uncertain: true }, { retryAt: now + 5_000 }]) {
    assert.equal(disabled(button(route(renderPreparation("forest", controller(flags)), "forest"), "Отправиться")), true);
    const html = render(controller({ ...flags, snapshot: snapshot({ jobs: [job({ finishesAt: new Date(now).toISOString() })] }) }));
    assert.equal(disabled(button(html, "Забрать находки: Лесная разведка")), true);
  }
  assert.match(render(controller({ uncertain: true })), /Проверить результат/);
  assert.equal(disabled(button(render(controller({ retryAt: now + 5_000 })), "Повторить через 5 с")), true);
});

test("initial loading and failure have no fabricated routes; unrelated DEV notices stay out", () => {
  let html = render(controller({ snapshot: null }));
  assert.match(html, /Открываем маршруты/);
  assert.doesNotMatch(html, /data-route|Отправиться/);
  html = render(controller({ snapshot: null, error: "Связь потеряна" }));
  assert.match(html, /Связь потеряна/);
  assert.equal(disabled(button(html, "Попробовать ещё раз")), false);
  html = render(controller({ notice: "Выдано 10000 монет в DEV" }));
  assert.doesNotMatch(html, /Выдано 10000/);
});

function activeView(savedJob = job(), options = {}) {
  const calls = [], confirmations = [], cancellations = [];
  const state = options.state ?? snapshot({ jobs: [savedJob] });
  const economy = controller({ snapshot: state, act: (...args) => calls.push(args), ...options.economy });
  const key = expeditionCancellationKey(state.ownerPublicId, savedJob);
  const props = { economy, state, job: savedJob, onOpenPantry() {},
    confirmationKey: options.confirmed ? key : options.confirmationKey ?? null,
    onConfirmation: value => confirmations.push(value), onCancellationSent: value => cancellations.push(value) };
  let tree;
  function Probe() { tree = ActiveExpedition(props); return tree; }
  const html = renderToStaticMarkup(createElement(Probe));
  const elements = [];
  function walk(element) {
    if (!isValidElement(element)) return;
    elements.push(element); Children.forEach(element.props.children, walk);
  }
  walk(tree);
  const control = label => elements.find(element => element.type === "button"
    && (element.props["aria-label"] === label || Children.toArray(element.props.children).filter(child => typeof child === "string").join("") === label));
  return { html, elements, control, calls, confirmations, cancellations, props, key };
}

test("recall requires a second explicit decision and never removes a job optimistically", () => {
  const saved = job({ targetId: "shore", rewards: { fish: 4 } });
  const first = activeView(saved);
  assert.doesNotMatch(first.html, /Вернуться без добычи|Все награды этой вылазки/);
  first.control("Вернуть Мохлика").props.onClick();
  assert.deepEqual(first.confirmations, [first.key]);
  assert.deepEqual(first.calls, []);
  const confirm = activeView(saved, { confirmationKey: first.key });
  assert.match(confirm.html, /Все награды этой вылазки будут потеряны/);
  assert.match(confirm.html, /role="group" aria-labelledby="[^"]+" aria-describedby="[^"]+"/);
  assert.ok(confirm.html.indexOf("Продолжить вылазку") < confirm.html.indexOf("Вернуться без добычи"), "safe action is first in tab order");
  const discard = confirm.control("Вернуться без добычи");
  assert.equal(discard.props.disabled, false);
  discard.props.onClick(); discard.props.onClick();
  assert.deepEqual(confirm.calls, [["cancel_exploration", saved.id]], "double clicking cannot issue another cancellation");
  assert.deepEqual(confirm.cancellations, [saved.id]);
  assert.deepEqual(confirm.confirmations, [null]);
  assert.equal(confirm.props.state.jobs[0], saved, "the card uses the confirmed snapshot until the response arrives");
  assert.deepEqual(confirm.props.state.inventory, {});
});

test("continuing a paid expedition sends no command and explains already-spent supplies", () => {
  const view = activeView(job({ targetId: "deep_cave", cost: { coins: 7, items: { smoked_fish: 1 } } }), { confirmed: true });
  assert.match(view.html, /Потраченные монеты и припасы не возвращаются/);
  view.control("Продолжить вылазку").props.onClick();
  assert.deepEqual(view.confirmations, [null]);
  assert.deepEqual(view.calls, []); assert.deepEqual(view.cancellations, []);
});

test("paid mining cancellation explains the exact refund while legacy hero expeditions stay nonrefundable", () => {
  for (const ready of [false, true]) {
    const saved = job({ targetId: "quarry_ore_hour", actorId: "miner", rewards: { ore: 6 }, cost: { coins: 7, items: { smoked_fish: 1 } }, finishesAt: new Date(now + (ready ? 0 : 60_000)).toISOString() });
    const view = activeView(saved, { confirmed: true });
    assert.match(view.html, /Все награды этой работы будут потеряны/);
    assert.match(view.html, /Потраченные монеты и припасы вернутся/);
    assert.doesNotMatch(view.html, /не возвращаются/);
    assert.deepEqual(view.calls, [], "the warning never refunds locally or dispatches by itself");
    view.control("Остановить без результата").props.onClick();
    assert.deepEqual(view.calls, [["cancel_exploration", saved.id]]);
    assert.deepEqual(view.props.state.inventory, {}, "the server remains the refund authority");
    const legacy = activeView({ ...saved, targetId: "deep_cave", actorId: undefined }, { confirmed: true });
    assert.match(legacy.html, /Потраченные монеты и припасы не возвращаются/);
    assert.doesNotMatch(legacy.html, /припасы вернутся/);
  }
});

test("unclaimed ready finds can be discarded without a claim, even if the pantry is full", () => {
  const ready = job({ finishesAt: new Date(now).toISOString() });
  const state = snapshot({ jobs: [ready], storage: { capacity: 200, used: 200, reserved: 0, available: 0, overflow: 0 } });
  const first = activeView(ready, { state });
  assert.equal(first.control("Отказаться от находок").props.disabled, false);
  const view = activeView(ready, { state, confirmed: true });
  assert.match(view.html, /Отказаться от этой добычи/);
  assert.ok(view.control("Оставить находки"));
  const claim = view.control("Забрать находки: Лесная разведка");
  assert.equal(claim.props.disabled, true); claim.props.onClick();
  view.control("Вернуться без добычи").props.onClick();
  assert.deepEqual(view.calls, [["cancel_exploration", ready.id]]);
});

test("busy, uncertain, cooldown and stale snapshots block both recall steps and handler dispatch", () => {
  const saved = job();
  for (const flags of [{ busy: true }, { uncertain: true }, { retryAt: now + 5000 },
    { snapshot: snapshot({ jobs: [] }) }, { snapshot: snapshot({ ownerPublicId: "OTHER", jobs: [saved] }) }]) {
    const view = activeView(saved, { confirmed: true, economy: flags });
    const recall = view.control("Вернуть Мохлика"), confirm = view.control("Вернуться без добычи");
    assert.equal(recall.props.disabled, true); assert.equal(confirm.props.disabled, true);
    recall.props.onClick(); confirm.props.onClick();
    assert.deepEqual(view.calls, []); assert.deepEqual(view.confirmations, []);
    const keep = view.control("Продолжить вылазку");
    assert.notEqual(keep.props.disabled, true); keep.props.onClick();
    assert.deepEqual(view.confirmations, [null], "backing out remains possible while the receipt is being checked");
  }
});

test("cancellation approval is scoped to the exact job and owner, while timer ticks preserve it", () => {
  const original = job(), key = expeditionCancellationKey("ME", original);
  for (const changed of [job({ id: crypto.randomUUID() }), job({ targetId: "shore" }),
    job({ finishesAt: new Date(now + 31_000).toISOString() }), job({ rewards: { fish: 40 } }),
    job({ cost: { coins: 3, items: {} } })]) {
    const view = activeView(changed, { confirmationKey: key });
    assert.doesNotMatch(view.html, /Вернуться без добычи/);
    assert.equal(view.control("Вернуть Мохлика").props["aria-expanded"], false);
  }
  const other = activeView(original, { confirmationKey: key, state: snapshot({ ownerPublicId: "OTHER", jobs: [original] }) });
  assert.doesNotMatch(other.html, /Вернуться без добычи/);
  const tick = activeView(original, { confirmationKey: key, economy: { now: now + 1000 } });
  assert.match(tick.html, /Вернуться без добычи/);
  assert.equal(tick.control("Вернуть Мохлика").props["aria-expanded"], true);
  assert.equal(expeditionCancellationKey("ME", job({ rewards: { fiber: 4, wood: 5, stone: 3 } })), key,
    "map key ordering does not create a different job approval");
});

function sectorView(sectorId, state, overrides = {}, props = {}) {
  const calls = [], visits = [], selections = [], elements = [];
  const economy = controller({ snapshot: state, act: (...args) => calls.push(args), ...overrides });
  let tree;
  function Probe() {
    tree = WorldExpeditionSector({ sectorId, selectedRoute: null, onSelectRoute: id => selections.push(id), economy, state,
      exploring: state.jobs.some(entry => entry.kind === "exploration" && entry.actorId !== "miner"), onOpenPantry() {},
      onOpenFishingShop: () => visits.push("plesk"), ...props });
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Probe));
  function walk(element) {
    if (!isValidElement(element)) return;
    elements.push(element);
    // Render the real route component under React so its equipment/receipt hooks
    // and handlers are inspected without reimplementing departure decisions.
    if (element.type === ExpeditionRouteDetails || element.type === WorldTacklePicker) {
      function Probe() { const detail = element.type(element.props); walk(detail); return detail; }
      renderToStaticMarkup(createElement(Probe));
    }
    Children.forEach(element.props.children, walk);
  }
  walk(tree);
  const depart = routeId => {
    const selected = state.catalog.explorations.find(entry => entry.id === routeId);
    return elements.find(element => element.type === "button"
      && element.props["aria-label"] === `${selected.activity === "mining" ? "Начать добычу" : "Отправиться"}: ${selected.name}`);
  };
  return { html, elements, calls, visits, selections, depart };
}

test("stage-two mining keeps one-item unboosted timers and no meal or paid-slot controls", () => {
  for (const selectedRoute of ["quarry_stone", "quarry_clay"]) {
    const state = snapshot({ buildings: { home: 2, warehouse: 1, quarry: 2 },
      inventory: { hearty_fish: 2, grilled_fish: 2 }, food: { heroMeal: "hearty_fish", builderMeal: "grilled_fish" } });
    const before = structuredClone(state), selected = state.catalog.explorations.find(entry => entry.id === selectedRoute);
    const list = route(renderSector("caves", controller({ snapshot: state })), selectedRoute);
    assert.match(list, /3 мин/); assert.ok(list.includes(economyCatalog.items.find(item => item.id === Object.keys(selected.rewards)[0]).name)); assert.doesNotMatch(list, /×1/);
    const view = sectorView("caves", state, {}, { selectedRoute });
    assert.match(view.html, /aria-label="Находки"/);
    assert.doesNotMatch(view.html, /Результат одной добычи|Условия маршрута|Без затрат/);
    assert.equal(view.depart(selectedRoute).props.disabled, false);
    assert.match(button(view.html, "Начать добычу").text, /3 мин/);
    assert.doesNotMatch(view.html, /скорость следующей вылазки|Сыт|Съесть|Угостить|Еда ускорит|data-production-slots|Открыть место/);
    view.depart(selectedRoute).props.onClick(); view.depart(selectedRoute).props.onClick();
    assert.deepEqual(view.calls, [["start_exploration", selected.id, 1, 0]]);
    assert.deepEqual(state, before, "quoted mining never consumes a pending hero or builder meal");
  }
});

test("miner and hero departures use independent queues while each ready result keeps its own queue occupied", () => {
  const buildings = { home: 2, warehouse: 1, quarry: 2 };
  const miner = job({ id: "miner", targetId: "quarry_stone", actorId: "miner", rewards: { stone: 1 } });
  const hero = job({ id: "hero" });
  for (const finished of [false, true]) {
    miner.finishesAt = hero.finishesAt = new Date(now + (finished ? 0 : 29_000)).toISOString();
    const mining = sectorView("caves", snapshot({ buildings, jobs: [hero] }), {}, { selectedRoute: "quarry_clay" });
    assert.equal(mining.depart("quarry_clay").props.disabled, false);
    mining.depart("quarry_clay").props.onClick();
    assert.deepEqual(mining.calls, [["start_exploration", "quarry_clay", 1, 0]]);
    const forest = sectorView("forest", snapshot({ buildings, jobs: [miner] }), {}, { selectedRoute: "forest" });
    assert.equal(forest.depart("forest").props.disabled, false);
    forest.depart("forest").props.onClick();
    assert.deepEqual(forest.calls, [["start_exploration", "forest", 1, 0]]);
    const occupied = sectorView("caves", snapshot({ buildings, jobs: [miner] }), {}, { selectedRoute: "quarry_clay" });
    assert.equal(occupied.depart("quarry_clay"), undefined);
    assert.match(occupied.html, finished ? /Сначала заберите добычу шахтёра/ : /Шахтёр ещё добывает материалы/);
    assert.deepEqual(occupied.calls, []);
  }
  const both = snapshot({ buildings, jobs: [miner, hero] });
  const travel = render(controller({ snapshot: both }));
  assert.match(travel, /Текущая вылазка: Лесная разведка/);
  assert.doesNotMatch(travel, /Текущая добыча:/);
  const mine = render(controller({ snapshot: both }), { embeddedCaves: true });
  assert.match(mine, /Текущая добыча: Добыть камень/);
  assert.doesNotMatch(mine, /Текущая вылазка: Лесная разведка/);
});

test("mining saved ownership participates in approval identity and stale claim or cancellation guards", () => {
  const miner = job({ targetId: "quarry_stone", actorId: "miner", rewards: { stone: 1 } });
  const key = expeditionCancellationKey("ME", miner);
  assert.notEqual(expeditionCancellationKey("ME", { ...miner, actorId: "mochlik" }), key);
  assert.notEqual(expeditionCancellationKey("ME", { ...miner, actorId: null }), key);
  const current = activeView(miner, { confirmed: true });
  assert.match(current.html, /Шахта работает|Прервать добычу/);
  assert.doesNotMatch(current.html, /Мохлик в пути|Мохлик вернётся/);
  current.control("Остановить без результата").props.onClick();
  current.control("Остановить без результата").props.onClick();
  assert.deepEqual(current.calls, [["cancel_exploration", miner.id]]);
  for (const actorId of [null, undefined, "mochlik"]) {
    const saved = { ...miner, finishesAt: new Date(now).toISOString() };
    const stale = activeView(saved, { confirmed: true, economy: { snapshot: snapshot({ jobs: [{ ...saved, actorId }] }) } });
    assert.equal(stale.control("Забрать находки: Добыть камень").props.disabled, true);
    stale.control("Забрать находки: Добыть камень").props.onClick();
    stale.control("Остановить без результата").props.onClick();
    assert.deepEqual(stale.calls, [], "the same job ID cannot authorize a different saved actor");
  }
  for (const actorId of [undefined, null]) {
    const legacy = activeView({ ...miner, actorId });
    assert.match(legacy.html, /Мохлик в пути/);
    assert.doesNotMatch(legacy.html, /data-mining=|Шахта работает/);
  }
});
const fishingGear = (overrides = {}) => ({ ownedRods: ["reed_rod", "river_rod", "willow_rod"], equippedRodId: "willow_rod",
  equippedBaitId: "worm_bait", catches: {}, ...overrides });

test("route selection and return only navigate, with no hidden departure forms in the list", () => {
  const state = snapshot();
  const list = sectorView("shore", state);
  const card = list.elements.find(element => element.type === "button" && element.props["data-route"] === "shore");
  assert.ok(card);
  assert.notEqual(card.props.disabled, true);
  assert.equal(list.elements.filter(element => element.type === ExpeditionRouteDetails).length, 0);
  assert.doesNotMatch(list.html, /<select\b|aria-label="Отправиться:/);
  card.props.onClick();
  assert.deepEqual(list.selections, ["shore"]);
  assert.deepEqual(list.calls, []);
  const preparation = sectorView("shore", state, {}, { selectedRoute: list.selections[0] });
  assert.equal(preparation.elements.filter(element => element.type === ExpeditionRouteDetails).length, 1);
  const back = preparation.elements.find(element => element.type === "button"
    && Children.toArray(element.props.children).some(child => child === "Все маршруты"));
  assert.ok(back); back.props.onClick();
  assert.deepEqual(preparation.selections, [null]);
  assert.deepEqual(preparation.calls, []);
  const returned = sectorView("shore", state, {}, { selectedRoute: preparation.selections[0] });
  assert.doesNotMatch(returned.html, /<select\b|aria-label="Отправиться:/);
  assert.match(returned.html, /data-route="shore_camp"/);
});

test("route cards describe their duration, rewards and preparation reason beyond their accessible name", () => {
  const view = sectorView("forest", snapshot({ buildings: { home: 3, warehouse: 1, dryer: 1, workshop: 2 } }));
  const card = view.elements.find(element => element.type === "button" && element.props["data-route"] === "old_woodland");
  const descriptionIds = card.props["aria-describedby"]?.trim().split(/\s+/);
  assert.ok(descriptionIds?.length, "the route name alone omits information needed to compare trips");
  const description = descriptionIds.map(id => {
    const target = view.elements.find(element => element.props.id === id);
    assert.ok(target, `Missing description target: ${id}`);
    return renderToStaticMarkup(target).replace(/<[^>]*>/g, " ");
  }).join(" ");
  assert.match(description, /8 ч/);
  assert.match(description, /Нужны припасы/);
  const catalogRoute = economyCatalog.explorations.find(entry => entry.id === "old_woodland");
  for (const [id, count] of Object.entries(catalogRoute.rewards)) {
    assert.ok(description.includes(economyCatalog.items.find(item => item.id === id).name));
    assert.match(description, new RegExp(`×\\s*${count}`));
  }
});

test("fishing preparation keeps visual gear, catch guarantees, supplies and departure visible", () => {
  const view = sectorView("shore", snapshot({ fishing: fishingGear(), inventory: {} }), {}, { selectedRoute: "shore" });
  assert.match(view.html, /aria-label="Снасти для вылазки"/);
  for (const kind of ["rod", "hook", "bait"]) assert.match(view.html, new RegExp(`data-tackle-slot="${kind}"`));
  assert.match(view.html, /Шансы улова/);
  assert.ok(view.html.indexOf("Шансы улова") < view.html.indexOf('aria-label="Отправиться:'), "actual odds are visible before departure");
  assert.match(view.html, /Улов за одну вылазку|Всего рыб/);
  assert.match(view.html, /Наживки за поход/);
  assert.match(view.html, /Не хватает припасов/);
  assert.equal(disabled(button(view.html, "Отправиться")), true);
  assert.doesNotMatch(view.html, /<select\b|<details[^>]*aria-label="Снасти для вылазки"/);
});

test("stale selections cannot prepare another sector or a route superseded by mine upgrades", () => {
  for (const selectedRoute of ["shore", "missing_route"]) {
    const view = sectorView("forest", snapshot(), {}, { selectedRoute });
    assert.doesNotMatch(view.html, /data-route-preparation="true"|<select\b|aria-label="Отправиться:/);
    assert.match(view.html, /data-route="forest"/);
    assert.deepEqual(view.calls, []);
  }
  const state = snapshot({ buildings: { home: 5, warehouse: 5, quarry: 5 } });
  for (const selectedRoute of ["quarry_shift", "quarry_deep_face"]) {
    const view = sectorView("caves", state, {}, { selectedRoute });
    assert.doesNotMatch(view.html, /data-route-preparation="true"|aria-label="Отправиться:/);
    assert.match(view.html, /data-route="quarry_supply"/);
  }
});

test("a future mine selection explains its exact quarry requirement and rejects departure", () => {
  for (const [selectedRoute, level] of [["quarry_stone", 1], ["quarry_clay", 2], ["cave", 1]]) {
    const view = sectorView("caves", snapshot({ buildings: { home: 3, warehouse: 1, quarry: 0 } }), {}, { selectedRoute });
    assert.match(view.html, new RegExp(`Каменоломня · нужен ур. ${level}`));
    assert.equal(view.depart(selectedRoute).props.disabled, true);
    view.depart(selectedRoute).props.onClick();
    assert.deepEqual(view.calls, []);
  }
  const firstHouse = sectorView("caves", snapshot(), {}, { selectedRoute: "quarry_stone" });
  assert.doesNotMatch(firstHouse.html, /data-route=|data-route-preparation/);
  assert.equal(firstHouse.depart("quarry_stone"), undefined);
});

test("a selected route cannot start while an exploration or a mine upgrade is still active", () => {
  const exploring = sectorView("shore", snapshot({ jobs: [job()] }), {}, { selectedRoute: "shore" });
  assert.match(exploring.html, /Сначала заберите находки или отмените текущую вылазку/);
  assert.equal(exploring.depart("shore"), undefined);
  assert.deepEqual(exploring.calls, []);
  const mining = sectorView("caves", snapshot({ buildings: { home: 3, warehouse: 3, quarry: 2 }, jobs: [job({ kind: "construction", targetId: "quarry", rewards: {}, targetLevel: 3 })] }), {}, { selectedRoute: "quarry_stone" });
  assert.match(mining.html, /Дождитесь улучшения шахты/);
  assert.equal(mining.depart("quarry_stone").props.disabled, true);
  mining.depart("quarry_stone").props.onClick();
  assert.deepEqual(mining.calls, []);
});

test("fishing departure shows equipped gear, charges one bait per trip and guards a missing-bait handler", () => {
  const state = snapshot({ fishing: fishingGear(), inventory: {} });
  const before = structuredClone(state);
  const missing = sectorView("shore", state, {}, { selectedRoute: "shore" });
  const shore = route(missing.html, "shore");
  assert.match(shore, /Ивовая удочка/); assert.match(shore, /Наживки за поход/);
  assert.match(shore, /Не хватает припасов/); assert.match(shore, /<strong>0 \/ 1<\/strong>/);
  assert.equal(missing.depart("shore").props.disabled, true);
  missing.depart("shore").props.onClick(); assert.deepEqual(missing.calls, []);
  const ready = sectorView("shore", snapshot({ ...state, inventory: { worm_bait: 1 } }), {}, { selectedRoute: "shore" });
  assert.equal(ready.depart("shore").props.disabled, false);
  ready.depart("shore").props.onClick(); assert.deepEqual(ready.calls, [["start_fishing", "shore", 1, 0]]);
  assert.deepEqual(state, before, "rendering and choosing a trip cannot deduct supplies optimistically");
  const bare = sectorView("shore", snapshot({ fishing: fishingGear({ equippedBaitId: null }), inventory: {} }), {}, { selectedRoute: "shore" });
  assert.match(route(bare.html, "shore"), /Без наживки/);
  assert.equal(bare.depart("shore").props.disabled, false);
});

test("fishing consumes the dedicated action only for declared routes and preserves legacy-backend departures", () => {
  const state = snapshot({ buildings: Object.fromEntries(economyCatalog.buildings.map(building => [building.id, 5])),
    inventory: { worm_bait: 1, smoked_fish: 3, dried_berries: 3 }, fishing: fishingGear() });
  for (const routeId of ["shore", "shore_camp", "coastal_deposits", "forest"]) {
    const view = sectorView(expeditionSector(routeId), state, {}, { selectedRoute: routeId });
    assert.equal(view.depart(routeId).props.disabled, false);
    view.depart(routeId).props.onClick();
    assert.deepEqual(view.calls, [[economyCatalog.fishing.routeIds.includes(routeId) ? "start_fishing" : "start_exploration", routeId, 1, 0]]);
  }
  const legacy = structuredClone(state); delete legacy.catalog.fishing; delete legacy.fishing;
  const fallback = sectorView("shore", legacy, {}, { selectedRoute: "shore" }); fallback.depart("shore").props.onClick();
  assert.deepEqual(fallback.calls, [["start_exploration", "shore", 1, 0]]);
  assert.doesNotMatch(route(fallback.html, "shore"), /Рыбный улов|Купить снасти/);
  assert.match(route(fallback.html, "shore"), new RegExp(economyCatalog.items.find(item => item.id === "fish").name));
  for (const flags of [{ busy: true }, { uncertain: true }, { retryAt: now + 1000 }]) {
    const locked = sectorView("shore", state, flags, { selectedRoute: "shore" });
    assert.equal(locked.depart("shore").props.disabled, true);
    locked.depart("shore").props.onClick(); assert.deepEqual(locked.calls, []);
  }
});

test("shore gear shortcuts open Pleska without spending and fishing keeps each route's advertised capacity", () => {
  const view = sectorView("shore", snapshot(), {}, { selectedRoute: "shore" });
  const shops = view.elements.filter(element => element.type === "button"
    && Children.toArray(element.props.children).some(child => child === "Купить снасти у Плёски"));
  assert.equal(shops.length, 1);
  shops[0].props.onClick(); assert.deepEqual(view.visits, ["plesk"]); assert.deepEqual(view.calls, []);
  const without = sectorView("shore", snapshot(), {}, { selectedRoute: "shore", onOpenFishingShop: undefined });
  assert.doesNotMatch(without.html, /Купить снасти у Плёски/);
  for (const routeId of economyCatalog.fishing.routeIds) {
    const entry = economyCatalog.explorations.find(route => route.id === routeId);
    const quantity = Object.values(entry.rewards).reduce((sum, count) => sum + count, 0);
    const full = sectorView("shore", snapshot({ storage: { capacity: quantity - 1, available: quantity - 1, used: 0, reserved: 0, overflow: 0 } }), {}, { selectedRoute: routeId });
    assert.equal(full.depart(routeId).props.disabled, true);
    assert.match(route(full.html, routeId), new RegExp(`Находки займут ${quantity} мест`));
    assert.match(route(full.html, routeId), /Всего рыб/);
    assert.match(route(full.html, routeId), new RegExp(`<dd>${economyCatalog.fishing.collectionDrawsByRoute[entry.id]}</dd>`));
  }
});

test("a completed fishing job shows its saved species before discovery and forfeits the exact result and bait on cancellation", () => {
  const saved = job({ targetId: "shore", rewards: { fish: 3, fish_mooncarp: 1 }, cost: { coins: 0, items: { worm_bait: 1 } },
    finishesAt: new Date(now).toISOString(), fishing: { rodId: "willow_rod", baitId: "worm_bait", fishId: "fish_mooncarp", catchRevealed: true } });
  const state = snapshot({ jobs: [saved], fishing: fishingGear({ equippedRodId: "reed_rod", equippedBaitId: null }) });
  const view = activeView(saved, { state, confirmed: true });
  assert.doesNotMatch(view.html, /Рыбный улов/);
  for (const fishId of ["fish", "fish_mooncarp"]) assert.match(view.html, new RegExp(economyCatalog.items.find(item => item.id === fishId).name));
  assert.match(view.html, /×3/); assert.match(view.html, /aria-label="Лунный карасик, 1"/);
  assert.match(view.html, /data-item-icon="fish_mooncarp"/); assert.doesNotMatch(view.html, /data-hidden-fish|Крючок этой вылазки/);
  assert.match(view.html, /data-fish-rarity="rare"/);
  assert.match(view.html, /Потраченные монеты и припасы не возвращаются/);
  view.control("Вернуться без добычи").props.onClick();
  assert.deepEqual(view.calls, [["cancel_exploration", saved.id]]);
  assert.deepEqual(state.jobs[0].rewards, { fish: 3, fish_mooncarp: 1 }); assert.deepEqual(state.inventory, {});
  const changed = { ...saved, fishing: { ...saved.fishing, rodId: "river_rod" } };
  assert.notEqual(expeditionCancellationKey(state.ownerPublicId, changed), view.key,
    "a cancellation confirmation cannot survive replacement of a saved fishing result");
});

function fishingDepartureView(state = snapshot(), overrides = {}) {
  const calls = [], elements = [];
  const economy = controller({ snapshot: state, act(...args) { calls.push(args); }, ...overrides });
  let tree;
  function Probe() {
    tree = ExpeditionRouteDetails({ state, economy, route: state.catalog.explorations.find(route => route.id === "shore"), exploring: false, onOpenPantry() {} });
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Probe));
  function walk(element) { if (!isValidElement(element)) return; elements.push(element); Children.forEach(element.props.children, walk); }
  walk(tree);
  const tackle = elements.find(element => element.type === WorldTacklePicker);
  const slots = {};
  if (tackle) {
    function Probe() { const choices = WorldTacklePicker(tackle.props); walk(choices); return choices; }
    renderToStaticMarkup(createElement(Probe));
    for (const element of elements) if (element.props["data-tackle-slot"]) slots[element.props["data-tackle-slot"]] = element;
  }
  const start = elements.find(element => element.type === "button" && element.props["aria-label"]?.startsWith("Отправиться:"));
  return { calls, html, ...slots, start, elements, choose: (kind, id) => tackle.props.onChoose(kind, id), options: kind => fishingTackleOptions(state, kind) };
}

test("departure offers only owned rods and allows bait from stock or explicitly no bait", () => {
  const state = snapshot({ fishing: fishingGear({ ownedRods: ["reed_rod", "river_rod"], equippedRodId: "reed_rod" }), inventory: { worm_bait: 2 } });
  const view = fishingDepartureView(state);
  const rodOptions = view.options("rod");
  assert.deepEqual(rodOptions.map(option => option.id), ["reed_rod", "river_rod"]);
  const baitOptions = view.options("bait");
  assert.equal(baitOptions.some(option => option.id === "crumb_bait"), false, "empty bait stays out of owned choices");
  assert.equal(baitOptions.find(option => option.id === "worm_bait").available, true);
  assert.equal(baitOptions.find(option => option.id === "none").available, true);
  view.choose("rod", "willow_rod");
  view.choose("bait", "crumb_bait");
  view.choose("bait", "unknown_bait");
  assert.deepEqual(view.calls, [], "forged unowned selections cannot issue an equipment command");
  view.choose("bait", "none");
  assert.deepEqual(view.calls, [["equip_fishing_bait", "none", 1, 0]]);
  assert.equal(state.fishing.equippedBaitId, "worm_bait", "selection is not applied optimistically");
});

test("departure exposes only owned hooks and waits for their confirmed selection before starting", () => {
  const state = snapshot({ fishing: fishingGear({ ownedHooks: ["bare_hook", "barbed_hook"], equippedHookId: "bare_hook", equippedBaitId: null }) });
  const view = fishingDepartureView(state);
  const options = view.options("hook");
  assert.deepEqual(options.map(option => option.id), ["bare_hook", "barbed_hook"]);
  assert.match(view.html, /Крючок/); assert.match(view.html, /data-tackle-slot="hook"/);
  view.choose("hook", "silver_hook");
  view.choose("hook", "unknown_hook");
  assert.deepEqual(view.calls, [], "unowned and unknown hooks cannot issue an equipment command");
  view.choose("hook", "barbed_hook"); view.start.props.onClick();
  assert.deepEqual(view.calls, [["equip_fishing_hook", "barbed_hook", 1, 0]]);
  assert.equal(state.fishing.equippedHookId, "bare_hook");
  assert.equal(state.inventory.barbed_hook, undefined);
  const confirmed = fishingDepartureView(snapshot({ fishing: { ...state.fishing, equippedHookId: "barbed_hook" } }));
  confirmed.start.props.onClick(); assert.deepEqual(confirmed.calls, [["start_fishing", "shore", 1, 0]]);
});

test("a missing owned hook blocks departure and saved jobs show their original hook after equipment changes", () => {
  const invalid = fishingDepartureView(snapshot({ fishing: fishingGear({ ownedHooks: ["bare_hook"], equippedHookId: "silver_hook", equippedBaitId: null }) }));
  assert.match(invalid.html, /Выберите крючок/); assert.match(invalid.html, /Выберите доступную удочку и крючок/);
  assert.equal(invalid.start.props.disabled, true); invalid.start.props.onClick(); assert.deepEqual(invalid.calls, []);
  const saved = job({ targetId: "shore", fishing: { rodId: "reed_rod", hookId: "barbed_hook", baitId: null, fishId: "fish" } });
  const state = snapshot({ jobs: [saved], fishing: fishingGear({ ownedHooks: ["bare_hook", "barbed_hook", "silver_hook"], equippedHookId: "silver_hook", equippedBaitId: null }) });
  const view = activeView(saved, { state });
  assert.doesNotMatch(view.html, /Крючок этой вылазки/);
  assert.notEqual(expeditionCancellationKey("ME", { ...saved, fishing: { ...saved.fishing, hookId: "silver_hook" } }), view.key);
  const legacy = activeView(job({ targetId: "shore", fishing: { rodId: "reed_rod", baitId: null, fishId: "fish" } }));
  assert.doesNotMatch(legacy.html, /Крючок этой вылазки/);
});

test("equipping then immediately departing waits for a confirmed snapshot and never auto-starts", () => {
  const state = snapshot({ fishing: fishingGear({ equippedRodId: "reed_rod", equippedBaitId: null }) });
  const before = fishingDepartureView(state);
  before.choose("rod", "river_rod");
  before.start.props.onClick(); before.start.props.onClick();
  assert.deepEqual(before.calls, [["equip_fishing_rod", "river_rod", 1, 0]], "equip and departure share the same synchronous receipt latch");
  const pending = fishingDepartureView(state, { busy: true });
  assert.equal(pending.rod.props.disabled, true); assert.equal(pending.hook.props.disabled, true); assert.equal(pending.bait.props.disabled, true); assert.equal(pending.start.props.disabled, true);
  pending.start.props.onClick(); assert.deepEqual(pending.calls, []);
  const confirmed = fishingDepartureView({ ...state, revision: state.revision + 1, fishing: { ...state.fishing, equippedRodId: "river_rod" } });
  assert.equal(confirmed.rod.props["data-tackle-equipped"], "river_rod"); assert.equal(confirmed.start.props.disabled, false);
  assert.deepEqual(confirmed.calls, [], "confirmation only updates the loadout; it does not start a trip");
  confirmed.start.props.onClick(); confirmed.start.props.onClick();
  assert.deepEqual(confirmed.calls, [["start_fishing", "shore", 1, 0]]);
});

test("equipment selectors and departure honor receipt recovery, cooldown and stale owner/revision", () => {
  const state = snapshot({ fishing: fishingGear({ equippedRodId: "reed_rod", ownedHooks: ["bare_hook", "barbed_hook"], equippedHookId: "bare_hook", equippedBaitId: null }), inventory: { worm_bait: 2 } });
  for (const flags of [{ uncertain: true }, { busy: true }, { retryAt: now + 5000 },
    { snapshot: { ...state, ownerPublicId: "OTHER" } }, { snapshot: { ...state, revision: state.revision + 1 } }]) {
    const view = fishingDepartureView(state, flags);
    assert.equal(view.rod.props.disabled, true); assert.equal(view.hook.props.disabled, true); assert.equal(view.bait.props.disabled, true); assert.equal(view.start.props.disabled, true);
    view.choose("rod", "river_rod"); view.choose("hook", "barbed_hook"); view.choose("bait", "worm_bait"); view.start.props.onClick();
    assert.deepEqual(view.calls, []);
  }
});


test("travel sectors only emit a soft tab cue for a changed destination", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { navigator: {}, localStorage: { getItem() { return null; }, setItem() {} } };
  const runtime = getAudioRuntime(), events = [];
  const originalPlay = runtime.play;
  runtime.play = event => events.push(event);
  try {
    let tree;
    function Probe() { tree = WorldExpeditionsMenu({ economy: controller(), onOpenPantry() {} }); return tree; }
    renderToStaticMarkup(createElement(Probe));
    const sectors = new Map();
    function walk(element) {
      if (!isValidElement(element)) return;
      if (element.props["data-sector-select"]) sectors.set(element.props["data-sector-select"], element);
      Children.forEach(element.props.children, walk);
    }
    walk(tree);
    sectors.get("forest").props.onClick();
    assert.deepEqual(events.map(event => event.cueId), ["ui.tab"], "opening an activity gives a soft cue");
    sectors.get("shore").props.onClick();
    assert.deepEqual(events.map(event => event.cueId), ["ui.tab", "ui.tab"]);
    assert.ok([...sectors.values()].every(element => element.props["data-audio-cue"] === undefined), "no delegated duplicate");
  } finally {
    runtime.play = originalPlay;
    runtime.dispose();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});


test("incompatible stocked bait is disabled and stale equipped bait blocks departure until removed", () => {
  const state = snapshot({ fishing: fishingGear({ equippedRodId: "reed_rod", equippedBaitId: null }), inventory: { star_bait: 2 } });
  const view = fishingDepartureView(state);
  const option = view.options("bait").find(option => option.id === "star_bait");
  assert.equal(option.available, false);
  view.choose("bait", "star_bait");
  assert.deepEqual(view.calls, [], "forged selection cannot equip unusable bait");
  const stale = snapshot({ ...state, fishing: { ...state.fishing, equippedBaitId: "star_bait" } });
  const blocked = fishingDepartureView(stale), before = structuredClone(stale);
  assert.equal(blocked.start.props.disabled, true);
  blocked.start.props.onClick(); assert.deepEqual(blocked.calls, []);
  assert.match(blocked.html, /Эта наживка не подходит к выбранной удочке/);
  const remove = blocked.elements.find(element => element.type === "button" && element.props.children === "Снять наживку");
  assert.ok(remove); remove.props.onClick();
  assert.deepEqual(blocked.calls, [["equip_fishing_bait", "none", 1, 0]]);
  assert.deepEqual(stale, before, "removal awaits server confirmation and cannot consume stock");
  const compatible = fishingDepartureView(snapshot({ ...state, fishing: { ...state.fishing, ownedRods: ["starfall_rod"], equippedRodId: "starfall_rod" } }));
  assert.equal(compatible.options("bait").find(option => option.id === "star_bait").available, true);
});


test("route review omits fulfilled progression and free or zero-valued provisions", () => {
  const state = snapshot(), before = structuredClone(state);
  state.catalog.explorations.find(route => route.id === "forest").cost.items.wood = 0;
  const view = sectorView("forest", state, {}, { selectedRoute: "forest" });
  assert.doesNotMatch(view.html, /Условия маршрута|Условия открытия|Без затрат|С собой|Припасы для вылазки|Дом Мохлика/);
  for (const content of ["Лесная разведка", "Бревно", "Камень", "Растительное волокно"]) assert.ok(view.html.includes(content));
  assert.equal(view.depart("forest").props.disabled, false);
  view.depart("forest").props.onClick();
  assert.deepEqual(view.calls, [["start_exploration", "forest", 1, 0]]);
  assert.deepEqual(state.wallet, before.wallet); assert.deepEqual(state.inventory, before.inventory);
});

test("route review retains only unmet building requirements and exact positive supplies", () => {
  const state = snapshot({ buildings: { home: 3, warehouse: 1, quarry: 0 }, inventory: { dried_berries: 1 } });
  const view = sectorView("caves", state, {}, { selectedRoute: "deep_cave", onUpgradeQuarry() {} });
  assert.match(view.html, /Условия открытия/); assert.match(view.html, /Каменоломня · нужен ур. 1/);
  assert.doesNotMatch(view.html, /Дом Мохлика|Без затрат|Условия маршрута/);
  assert.match(view.html, /Сушёные ягоды/); assert.match(view.html, /Копчёная рыба/);
  assert.match(view.html, /×1/); assert.match(view.html, /0 \/ 1/);
  assert.equal(view.depart("deep_cave").props.disabled, true);
  view.depart("deep_cave").props.onClick(); assert.deepEqual(view.calls, []);
});

test("running and ready route help targets show all saved work and the resource chooser without another launch form", () => {
  for (const ready of [false, true]) {
    const miner = job({ id: "miner", targetId: "quarry_stone", actorId: "miner", rewards: { stone: 1 }, cost: { coins: 7, items: { wood: 3 } }, finishesAt: new Date(now + (ready ? 0 : 30_000)).toISOString() });
    const legacy = job({ id: "legacy", targetId: "cave", rewards: { stone: 12, ore: 6 } });
    const state = snapshot({ buildings: { home: 3, quarry: 2, warehouse: 1 }, jobs: [miner, legacy] });
    const calls = [], html = render(controller({ snapshot: state, act: (...args) => calls.push(args) }), { embeddedCaves: true, initialRouteId: miner.targetId });
    assert.match(html, /Текущая добыча: Добыть камень/); assert.match(html, /Текущая вылазка: Вход в пещеру/);
    assert.match(html, /aria-label="Время добычи"/); assert.match(html, /data-mining-resource="stone"/);
    assert.doesNotMatch(html, /data-route-preparation="true"|Условия открытия|Припасы для вылазки|Начать добычу:/);
    assert.deepEqual(calls, []);
    const current = activeView(miner, { state });
    assert.match(current.html, /Камень/);
    assert.doesNotMatch(current.html, /Дом Мохлика|С собой|Для добычи|Без затрат|Не хватает припасов|Условия/);
  }
});

test("matching legacy quarry production suppresses only its duplicated route preview", () => {
  const saved = job({ kind: "production", targetId: "quarry", recipeId: "quarry_stone", rewards: { stone: 1 } });
  const state = snapshot({ buildings: { home: 3, quarry: 2, warehouse: 1 }, jobs: [saved] });
  const same = sectorView("caves", state, {}, { selectedRoute: "quarry_stone" });
  assert.doesNotMatch(same.html, /data-route-preparation="true"|Начать добычу:/);
  assert.match(same.html, /aria-label="Время добычи"/); assert.deepEqual(same.calls, []);
  const next = sectorView("caves", state, {}, { selectedRoute: "quarry_clay" });
  assert.match(next.html, /data-route-preparation="true"/);
  assert.equal(next.depart("quarry_clay").props.disabled, false);
  assert.deepEqual(state.jobs, [saved]); assert.deepEqual(next.calls, []);
});

test("sufficient provisions show only required amounts while shortages retain available versus required", () => {
  const state = snapshot({ wallet: { coins: 999999, pearls: 0 }, inventory: { wood: 888888 } });
  const selected = state.catalog.explorations.find(route => route.id === "forest");
  selected.cost = { coins: 12, items: { wood: 2 } };
  const enough = sectorView("forest", state, {}, { selectedRoute: "forest" });
  assert.match(enough.html, /Монеты/); assert.match(enough.html, /×12/); assert.match(enough.html, /×2/);
  assert.doesNotMatch(enough.html, /999|888/);
  assert.equal(enough.depart("forest").props.disabled, false);
  const missing = sectorView("forest", { ...state, wallet: { coins: 3, pearls: 0 }, inventory: { wood: 1 } }, {}, { selectedRoute: "forest" });
  assert.match(missing.html, /3 \/ 12/); assert.match(missing.html, /1 \/ 2/);
  assert.equal(missing.depart("forest").props.disabled, true);
  missing.depart("forest").props.onClick(); assert.deepEqual(missing.calls, []);
});

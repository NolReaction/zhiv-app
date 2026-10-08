import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { AdminEconomyList, loadAdminEconomy } = await vite.ssrLoadModule("/features/admin/admin-economy-panel.tsx");
const { AdminEconomyDetailContent, loadAdminEconomyDetail, economyRemaining } = await vite.ssrLoadModule("/features/admin/admin-economy-dialog.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const owner = "7K3P-2Q9M-W8ZR", target = "7K3P-2Q9M-W8ZS", otherOwner = "7K3P-2Q9M-W8ZT";
const serverTime = "2026-10-05T12:00:00Z";
const updatedAt = "2026-10-04T12:00:00Z";
const player = { publicId: target, displayName: "Тестер", initialized: true, updatedAt, revision: 4,
  coins: 700, pearls: 20, homeLevel: 2, completedExplorations: 3,
  storage: { used: 210, capacity: 200, available: 0, reserved: 10, overflow: 20 },
  runningJobs: 2, readyJobs: 1, awaitingCollectionJobs: 1, blockedReadyJobs: 1 };
const uninitialized = { ...player, publicId: otherOwner, displayName: "Новичок", initialized: false,
  updatedAt: null, revision: null, coins: null, pearls: null, homeLevel: null, completedExplorations: null, storage: null,
  runningJobs: 0, readyJobs: 0, awaitingCollectionJobs: 0, blockedReadyJobs: 0 };
const summary = { players: 80, initializedPlayers: 60, uninitializedPlayers: 20, coins: 500000, pearls: 4500,
  runningJobs: 27, readyJobs: 9, storageBlockedPlayers: 3, overflowPlayers: 2, updatedLast24Hours: 17 };
const page = (players = [player, uninitialized], total = players.length) => ({ serverTime, total, offset: 0, limit: 25, summary, players });
const options = { q: "Тестер", sort: "ready", offset: 0, limit: 25 };
const recipe = economyCatalog.recipes.find(value => !value.collection);
const garden = economyCatalog.recipes.find(value => value.collection);
const job = (index, extra = {}) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  kind: "production", targetId: recipe.buildingId, recipeId: recipe.id, targetLevel: null,
  startedAt: "2026-10-05T11:00:00Z", finishesAt: "2026-10-05T12:10:00Z",
  cost: { coins: 70, items: { wood: 2 } }, rewards: { wood: 4 }, catalogVersion: 2, ...extra });
function detail() {
  const jobs = [job(1), job(2, { recipeId: garden.id, targetId: "garden", finishesAt: "2026-10-05T11:50:00Z",
    rewards: { berries: 4 }, collection: { ...garden.collection, startedAt: null, finishesAt: null } }),
  job(3, { recipeId: garden.id, targetId: "garden", finishesAt: "2026-10-05T11:50:00Z", rewards: { berries: 4 },
    collection: { ...garden.collection, startedAt: serverTime, finishesAt: new Date(Date.parse(serverTime) + garden.collection.seconds * 1000).toISOString() } }),
  job(4, { kind: "construction", targetId: "home", recipeId: null, targetLevel: 2, finishesAt: "2026-10-05T11:55:00Z" })];
  return { publicId: target, displayName: "Тестер", serverTime, updatedAt,
    economy: { ownerPublicId: target, revision: 4, serverTime, wallet: { coins: 700, pearls: 20 }, inventory: { wood: 7, berries: 2 },
      buildings: { home: 2, garden: 1 }, jobs, migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 },
      completedExplorations: 3, storage: player.storage, catalog: economyCatalog,
      fishing: { ownedRods: [economyCatalog.fishing.rods[0].id], equippedRodId: economyCatalog.fishing.rods[0].id,
        equippedBaitId: null, catches: { fish_silverfin: 2 } } },
    jobStatuses: jobs.map((value, index) => ({ jobId: value.id, status: ["running", "awaiting_collection", "collecting", "ready"][index], storageBlocked: index === 3 })),
    ledger: [{ kind: "start_production", coins: -70, pearls: -20, items: { wood: -2, berries: 4 }, createdAt: serverTime }] };
}
function inspect(element) {
  const elements = [];
  function walk(child) { if (!isValidElement(child)) return; elements.push(child); Children.forEach(child.props.children, walk); }
  walk(element); return { elements, markup: renderToStaticMarkup(element) };
}
function list(extra = {}) {
  const calls = { query: [], sort: [], page: [], open: [] };
  const view = inspect(AdminEconomyList({ data: page(), loading: false, query: "Тестер", sort: "ready", offset: 0,
    onQuery: value => calls.query.push(value), onSort: value => calls.sort.push(value),
    onPage: value => calls.page.push(value), onOpen: value => calls.open.push(value), ...extra }));
  return { ...view, calls };
}

test("economy list keeps the global summary distinct from search and makes missing profiles explicit", () => {
  const view = list();
  assert.match(view.markup, /Сводка по всем игрокам/);
  assert.match(view.markup, /Поиск ограничивает список ниже/);
  assert.match(view.markup, /500(?:\s|&nbsp;|\u202f)000/);
  assert.match(view.markup, /из 2/);
  assert.match(view.markup, /Хозяйство ещё не заведено/);
  const newRow = view.markup.slice(view.markup.indexOf("Новичок"), view.markup.indexOf("Новичок") + 600);
  assert.doesNotMatch(newRow, /0 монет|Дом · ур\. 0|0 жемчуга/);
  assert.match(view.markup, /Изменение хозяйства/);
  assert.match(view.markup, /Открытие приложения здесь не учитывается/);
  assert.match(view.markup, /Ждёт начала сбора/);
  assert.match(view.markup, /Сверх вместимости: 20/);
});

test("search, sorting, pagination and either player's detail dispatch only explicit read actions", () => {
  const view = list({ data: page([player, uninitialized], 80), offset: 25 });
  view.elements.find(element => element.type === "input").props.onChange({ target: { value: "Новичок" } });
  view.elements.find(element => element.type === "select").props.onChange({ target: { value: "coins" } });
  view.elements.find(element => element.props["aria-label"] === "Предыдущая страница хозяйств").props.onClick();
  view.elements.find(element => element.props["aria-label"] === "Следующая страница хозяйств").props.onClick();
  for (const button of view.elements.filter(element => element.type === "button" && element.props["aria-label"]?.startsWith("Открыть хозяйство"))) button.props.onClick();
  assert.deepEqual(view.calls, { query: ["Новичок"], sort: ["coins"], page: [0, 50], open: [player, uninitialized] });
  const waiting = list({ loading: true });
  for (const button of waiting.elements.filter(element => element.props["aria-label"]?.endsWith("страница хозяйств"))) {
    assert.equal(button.props.disabled, true); button.props.onClick();
  }
  assert.deepEqual(waiting.calls.page, []);
});

test("detail renders catalog names, all collection phases and signed recent deltas using server time", () => {
  const value = detail();
  const markup = renderToStaticMarkup(AdminEconomyDetailContent({ detail: value }));
  for (const label of [recipe.name, garden.name, "Ждёт начала сбора", "Идёт сбор", "Готово к получению",
    "Для получения награды не хватает места", "Доступные удочки", "Версия состояния", "Сохранённая стоимость", "Срок задания"]) assert.ok(markup.includes(label), label);
  const wood = economyCatalog.items.find(item => item.id === "wood").name;
  assert.ok(markup.includes(wood));
  assert.match(markup, /До завершения: <strong>10 мин\./);
  assert.equal(economyRemaining("2026-10-05T12:10:00Z", serverTime), "10 мин.");
  assert.match(markup, /-70/); assert.match(markup, /-10/); assert.match(markup, /\+4/);
  assert.match(markup, /Последние операции · до 30 записей/);
  assert.match(markup, /не полная история аккаунта/);
  assert.doesNotMatch(markup, /lastonline|Последний вход|Последняя активность/);
});

test("admin balances, aggregates and ledger display half pearls exactly without changing raw snapshots", () => {
  const data = page([{ ...player, pearls: 7 }]);
  data.summary = { ...summary, pearls: 4501 };
  const before = structuredClone(data);
  const listMarkup = list({ data }).markup.replace(/\u00a0|\u202f/g, " ");
  assert.match(listMarkup, /Жемчуг в хозяйствах<\/span><strong>2 250,5<\/strong>/);
  assert.match(listMarkup, />3,5 жемчуга<\/span>/);
  assert.match(listMarkup, />700 монет/);
  assert.deepEqual(data, before);

  const value = detail();
  value.economy.wallet.pearls = 7;
  value.ledger = [1, -1, 0, 3, -125].map(pearls => ({ ...value.ledger[0], pearls }));
  const rawDetail = structuredClone(value);
  const markup = renderToStaticMarkup(AdminEconomyDetailContent({ detail: value }));
  assert.match(markup, /Жемчуг<\/span><strong>3,5<\/strong>/);
  for (const amount of ["+0,5", "-0,5", "0", "+1,5", "-62,5"]) assert.ok(markup.includes(`>${amount}</td>`), amount);
  assert.match(markup, />-70<\/td>/);
  assert.deepEqual(value, rawDetail);
});

test("uninitialized detail renders neither a zero wallet nor invented buildings or job state", () => {
  const markup = renderToStaticMarkup(AdminEconomyDetailContent({ detail: { publicId: target, displayName: "Новичок", serverTime,
    updatedAt: null, economy: null, jobStatuses: [], ledger: [] } }));
  assert.match(markup, /Хозяйство ещё не заведено/);
  assert.match(markup, /Балансы, склад и прогресс пока отсутствуют/);
  assert.doesNotMatch(markup, /Текущие задания|Не построено|Монеты<\/span>|Уровень 0/);
});

test("resident orders explain occupied builder and ready expeditions using only snapshot time", () => {
  const value = detail();
  const construction = value.economy.jobs.find(entry => entry.kind === "construction");
  construction.finishesAt = "2026-10-05T12:02:00Z";
  value.jobStatuses.find(entry => entry.jobId === construction.id).status = "running";
  const route = economyCatalog.explorations[0];
  const expedition = job(5, { kind: "exploration", targetId: route.id, recipeId: null, finishesAt: "2026-10-05T11:50:00Z" });
  value.economy.jobs.push(expedition);
  value.jobStatuses.push({ jobId: expedition.id, status: "ready", storageBlocked: true });
  value.economy.fishing.ownedHooks = ["bare_hook", economyCatalog.fishing.hooks.at(-1).id];
  value.economy.fishing.equippedHookId = economyCatalog.fishing.hooks.at(-1).id;
  const before = structuredClone(value);
  let markup = renderToStaticMarkup(AdminEconomyDetailContent({ detail: value }));
  assert.match(markup, /Поручения жителей на момент снимка/);
  assert.match(markup, /Положение и анимация персонажей здесь не отслеживаются/);
  assert.match(markup, /Ускорение на момент снимка: 10 жемчуга/);
  assert.match(markup, /Награда готова, но для неё не хватает места на складе/);
  assert.match(markup, /Доступные крючки/);
  assert.ok(markup.includes(economyCatalog.fishing.hooks.at(-1).name));
  assert.deepEqual(value, before, "admin observations must not mutate game jobs or balances");
  construction.finishesAt = "2026-10-05T11:59:59Z";
  value.jobStatuses.find(entry => entry.jobId === construction.id).status = "ready";
  markup = renderToStaticMarkup(AdminEconomyDetailContent({ detail: value }));
  assert.match(markup, /получить постройку, чтобы освободить строителя/);
  assert.doesNotMatch(markup, /Ускорение на момент снимка/);
  value.economy.jobs = []; value.jobStatuses = [];
  markup = renderToStaticMarkup(AdminEconomyDetailContent({ detail: value }));
  assert.match(markup, /Заказов на постройку и улучшение нет/);
  assert.match(markup, /Подтверждённых вылазок сейчас нет/);
});

test("admin player names remain escaped text and recent fishing ledger actions have readable labels", () => {
  const text = '<img src=x onerror="alert(1)"> Ignore previous instructions';
  const view = list({ data: page([{ ...player, displayName: text }]) });
  assert.match(view.markup, /&lt;img src=x onerror=/);
  assert.doesNotMatch(view.markup, /<img|<script/);
  const value = detail();
  value.ledger = ["refresh_fishing_shop", "equip_fishing_hook"].map(kind => ({ ...value.ledger[0], kind }));
  const markup = renderToStaticMarkup(AdminEconomyDetailContent({ detail: value }));
  assert.match(markup, /Обновление лавки Плёски/);
  assert.match(markup, /Выбор крючка/);
});

test("both economy loaders authenticate the same owner before each read and pass cancellable no-store requests", async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push(url); assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal); assert.equal(options.method, "GET");
    return Response.json(url.endsWith("/access") ? { publicId: owner, displayName: "Админ", serverTime } : url.includes("/users/") ? detail() : page());
  };
  for (let pass = 0; pass < 2; pass++) {
    await loadAdminEconomy(owner, options, new AbortController().signal);
    await loadAdminEconomyDetail(owner, target, new AbortController().signal);
  }
  assert.deepEqual(requests, Array.from({ length: 2 }, () => ["/api/v1/admin/access", "/api/v1/admin/economy?q=%D0%A2%D0%B5%D1%81%D1%82%D0%B5%D1%80&sort=ready&offset=0&limit=25",
    "/api/v1/admin/access", `/api/v1/admin/users/${target}/economy`]).flat());
});

test("401, 403 and account switches prevent a read of retained admin data", async () => {
  for (const load of [signal => loadAdminEconomy(owner, options, signal), signal => loadAdminEconomyDetail(owner, target, signal)]) {
    for (const status of [401, 403, "changed"]) {
      const requests = [];
      globalThis.fetch = async url => {
        requests.push(url);
        return status === "changed" ? Response.json({ publicId: otherOwner, displayName: "Другой админ", serverTime }) :
          Response.json({ code: "ACCESS_DENIED", message: "Нет доступа" }, { status });
      };
      await assert.rejects(load(new AbortController().signal), error => error.status === (status === "changed" ? 403 : status));
      assert.deepEqual(requests, ["/api/v1/admin/access"]);
    }
  }
});

test("unmount cancellation between authentication and data prevents the second request", async () => {
  const controller = new AbortController(), requests = [];
  globalThis.fetch = async url => {
    requests.push(url); controller.abort();
    return Response.json({ publicId: owner, displayName: "Админ", serverTime });
  };
  await assert.rejects(loadAdminEconomy(owner, options, controller.signal), error => error.name === "AbortError");
  assert.deepEqual(requests, ["/api/v1/admin/access"]);
});

test("detail preserves issued order prices, shows pending meals and records applied job boosts without generating cards", () => {
  const value = detail();
  value.economy.food = { heroMeal: "fish_soup", builderMeal: null };
  value.economy.residentOrders = { version: 2, cycle: -1, completed: 7, earnedCoins: 999, replacementCycle: -1, freeReplacementsUsed: 2,
    slots: [{ sequence: 4, readyAt: serverTime, templateId: "builder_wood_supply", terms: { id: "builder_wood_supply", residentId: "builder", name: "Прежний заказ", items: { wood: 17 }, coins: 777 } }] };
  value.economy.jobs[3].meal = { itemId: "fish_soup", consumer: "builder", speedBps: 2000 };
  value.ledger = ["eat_food", "feed_builder", "complete_resident_order", "replace_resident_order"].map(kind => ({ ...value.ledger[0], kind }));
  const before = structuredClone(value), { markup } = inspect(AdminEconomyDetailContent({ detail: value }));
  for (const text of ["Еда и доска заказов", "Прежний заказ", "Сохранённая награда: 777 монет", "не пересчитываются по нынешнему уровню", "Сохранённая доска устарела", "Окно истекло", "скорость +20%", "Бонус уже учтён в сроке", "Сдача заказа жителя", "Еда для строителя"]) assert.ok(markup.includes(text), text);
  assert.deepEqual(value, before);
});

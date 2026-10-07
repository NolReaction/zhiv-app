import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { AdminAnalyticsContent, AdminAnalyticsEventList } = await vite.ssrLoadModule("/features/admin/admin-analytics-panel.tsx");
const { AdminGameplayAnalytics, AdminPresenceAnalytics } = await vite.ssrLoadModule("/features/admin/admin-gameplay-analytics.tsx");
const { analyticsCsv, analyticsAmount, analyticsPeriod, analyticsPeriodError } = await vite.ssrLoadModule("/features/admin/admin-analytics-utils.ts");

const serverTime = "2026-10-07T12:00:00Z", publicId = "7K3P-2Q9M-W8ZR";
const analytics = () => ({ serverTime, from: "2026-10-01", to: "2026-10-07", startAt: "2026-10-01T00:00:00Z", endAt: serverTime, q: "", scope: "players",
  summary: { activePlayers: 3, events: 12, spendingPlayers: 2, constructionStarts: 4, constructionClaims: 2, constructionPlayers: 2 },
  daily: [{ date: "2026-10-01", players: 3, events: 12, constructionStarts: 4 }],
  resources: [{ resourceId: "pearls", received: 3, spent: 5, reserved: 2, returned: 1, net: -3, players: 2 }],
  flows: [{ kind: "speedup_construction", targetId: "home", resourceId: "pearls", category: "gameplay", received: 0, spent: 5, players: 2, events: 2 },
    { kind: "market_create", targetId: "wood", resourceId: "pearls", category: "escrow", received: 0, spent: 2, players: 1, events: 1 }],
  actions: [{ kind: "start_construction", targetId: "home", events: 4, players: 2 }],
  construction: [{ buildingId: "home", starts: 4, claims: 2, players: 2 }],
  firstConstructions: [{ buildingId: "home", players: 1 }, { buildingId: null, players: 1 }],
  buildingLevels: [{ buildingId: "home", level: 0, players: 1 }, { buildingId: "home", level: 2, players: 3 }],
  gameplay: { mealsConsumed: 0, foodPlayers: 0, ordersCompleted: 0, orderPlayers: 0, orderCoinsEarned: 0, orderReplacements: 0, paidOrderReplacements: 0, orderPearlsSpent: 0 }, meals: [], orders: [], presence: { coverageFrom: null, players: 0, onlineSeconds: 0, flaggedPlayers: 0, daily: [], reviewDays: [], reviewDaysTruncated: false }, coverage: { firstRecordedAt: "2026-09-01T12:00:00Z", unattributedEvents: 2, matchingPlayers: 5, initializedPlayers: 4, flowsTruncated: false, actionsTruncated: false, ordersTruncated: false },
});
function inspect(element) {
  const elements = [];
  function walk(child) { if (!isValidElement(child)) return; elements.push(child); Children.forEach(child.props.children, walk); }
  walk(element); return { elements, markup: renderToStaticMarkup(element) };
}
function content(data = analytics()) {
  const calls = [];
  const view = inspect(AdminAnalyticsContent({ data, resource: "pearls", building: "home", onResource() {}, onBuilding() {}, onEvents: value => calls.push(value) }));
  return { ...view, calls };
}
test("analytics distinguishes historical choices, present levels and UTC activity; unknown first choice remains in denominator", () => {
  const { markup } = content();
  for (const text of ["Первое наблюдённое строительство", "Текущие уровни построек", "независимо от периода", "не обязательно первое улучшение", "Объект не записан", "1 · 50%", "Точные значения по дням", "Технические переносы и DEV-выдачи исключены", "сразу завершил её ускорением"]) assert.ok(markup.includes(text), text);
  assert.match(markup, /У 2 операций за период не сохранён контекст объекта/);
  assert.doesNotMatch(markup, /Последний вход|время онлайн|Время в игре/);
});
test("half-pearl amounts and escrow are not reported as gameplay spending", () => {
  const raw = analytics(), before = structuredClone(raw), view = content(raw);
  assert.match(view.markup, /Получено<\/span><strong>1,5<\/strong>/);
  assert.match(view.markup, /Потрачено<\/span><strong>2,5<\/strong>/);
  assert.match(view.markup, /Чистое изменение<\/span><strong>-1,5<\/strong>/);
  assert.match(view.markup, /из резерва возвращено: <strong>0,5<\/strong>/);
  const bars = view.elements.filter(element => element.type === "button" && element.props.children?.[0]?.props?.children?.[0] === "Ускорение стройки");
  assert.equal(bars.length, 1);
  bars[0].props.onClick();
  assert.deepEqual(view.calls, [{ kind: "speedup_construction", resource: "pearls", direction: "out" }]);
  assert.deepEqual(raw, before);
  assert.equal(analyticsAmount("pearls", -1, true), "-0,5");
  assert.equal(analyticsAmount("coins", 3, true), "+3");
});
test("empty periods and truncated aggregates are explicit", () => {
  const data = analytics(); data.summary.events = 0; data.flows = []; data.actions = []; data.firstConstructions = []; data.buildingLevels = [];
  data.coverage.flowsTruncated = true; data.coverage.actionsTruncated = true;
  const { markup } = content(data);
  for (const text of ["подтверждённых операций нет", "Расходов этого ресурса", "Первых наблюдённых строек", "Сохранённых хозяйств", "Ответ ограничен 1 000 группами"]) assert.ok(markup.includes(text), text);
});
test("a selected resource remains selected when the next period has no movement of that resource", () => {
  const data = analytics(); data.resources = []; data.flows = [];
  const view = inspect(AdminAnalyticsContent({ data, resource: "wood", building: "home", onResource() {}, onBuilding() {}, onEvents() {} }));
  const selector = view.elements.find(element => element.type === "select" && element.props.value === "wood");
  assert.ok(selector);
  assert.ok(view.elements.some(element => element.type === "option" && element.props.value === "wood"));
  assert.match(view.markup, /<option value="wood" selected=""/);
});
function events(extra = {}) {
  return { ...analytics(), kind: "", resource: "", direction: "all", at: null, offset: 0, limit: 25, total: 31,
    events: [{ id: "event:1", publicId, displayName: '<img src=x onerror="x">', createdAt: "2026-10-07T11:00:00Z", kind: "start_construction", targetId: "home", quantity: null,
      contextKnown: true, category: "gameplay", coins: -25, pearls: -1, items: { wood: -3, berries: 2 } }], ...extra };
}
test("journal renders escaped player names, signed resources, only explicit drilldowns and bounded pages", () => {
  const data = events(), calls = { open: [], player: [], page: [] };
  const view = inspect(AdminAnalyticsEventList({ data, loading: false, onOpen: value => calls.open.push(value.publicId), onPlayer: value => calls.player.push(value.publicId), onPage: value => calls.page.push(value) }));
  assert.match(view.markup, /&lt;img src=x onerror=/); assert.doesNotMatch(view.markup, /<img/);
  assert.match(view.markup, />-0,5<\/strong>/); assert.match(view.markup, />-25<\/strong>/); assert.match(view.markup, />\+2<\/strong>/);
  assert.match(view.markup, /CSV этой страницы/);
  view.elements.find(element => element.props["aria-label"]?.startsWith("Открыть хозяйство")).props.onClick();
  view.elements.find(element => element.props.children === "Все операции игрока").props.onClick();
  for (const button of view.elements.filter(element => element.type === "button" && Array.isArray(element.props.children) && element.props.children.some(child => child === "Назад" || child === "Далее"))) button.props.onClick();
  assert.deepEqual(calls, { open: [publicId], player: [publicId], page: [25] });
  const waiting = inspect(AdminAnalyticsEventList({ data: events({ offset: 25 }), loading: true, onOpen() {}, onPlayer() {}, onPage: value => calls.page.push(value) }));
  for (const button of waiting.elements.filter(element => element.type === "button" && element.props.disabled === true)) button.props.onClick();
  assert.deepEqual(calls.page, [25]);
});
test("UTC quick periods and custom dates reject invalid, reversed, future and oversized ranges", () => {
  const now = new Date("2026-10-07T23:59:59Z");
  assert.deepEqual(analyticsPeriod(7, now), { from: "2026-10-01", to: "2026-10-07" });
  assert.deepEqual(analyticsPeriod(1, now), { from: "2026-10-07", to: "2026-10-07" });
  assert.equal(analyticsPeriodError("2025-10-07", "2026-10-07", now), null);
  for (const [from, to] of [["", ""], ["2026-02-30", "2026-03-02"], ["2026-10-07", "2026-10-01"], ["2026-10-07", "2026-10-08"], ["2025-10-06", "2026-10-07"]]) assert.ok(analyticsPeriodError(from, to, now), `${from} ${to}`);
});
test("CSV protects formula cells while preserving actual numeric deltas, quotes, Cyrillic and multiline text", () => {
  const csv = analyticsCsv([["Имя", "Монеты", "Жемчуг"], ["=IMPORTXML(1)", -70, -0.5], [" \t+SUM(A1)", 1, null], ['Тестер; "да"\nнет', 2, 3], ["@test", "-1+1", "\r=1"]]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes('"\'=IMPORTXML(1)";"-70";"-0.5"'));
  assert.ok(csv.includes('"\' \t+SUM(A1)"'));
  assert.ok(csv.includes('"Тестер; ""да""\nнет"'));
  assert.ok(csv.includes('"\'@test";"\'-1+1";"\'\r=1"'));
});

test("food and orders use actual ledger totals, distinguish free replacements and link to the relevant history", () => {
  const data = analytics();
  data.gameplay = { mealsConsumed: 3, foodPlayers: 2, ordersCompleted: 4, orderPlayers: 2, orderCoinsEarned: 750, orderReplacements: 3, paidOrderReplacements: 1, orderPearlsSpent: 5 };
  data.meals = [{ itemId: "fish_soup", heroPortions: 2, builderPortions: 1, players: 2 }];
  data.orders = [{ templateId: "builder_wood_supply", completed: 4, replacements: 3, paidReplacements: 1, coinsEarned: 750, pearlsSpent: 5, players: 2 }];
  const calls = [], view = inspect(AdminGameplayAnalytics({ data, onEvents: value => calls.push(value) }));
  for (const text of ["Съедено порций", "750 монет выдано", "2,5 жемчуга списано", "это не число ускоренных заданий", "Шишколап", "Бесплатные замены", "Эффект может сохраняться"]) assert.ok(view.markup.includes(text), text);
  view.elements.find(node => node.type === "button" && node.props.children === "Сданные заказы").props.onClick();
  view.elements.find(node => node.type === "button" && node.props.children === "Замены заказов").props.onClick();
  view.elements.find(node => node.type === "button" && node.props.children === "Кормление строителя").props.onClick();
  assert.deepEqual(calls, [{ kind: "complete_resident_order" }, { kind: "replace_resident_order" }, { kind: "feed_builder" }]);
});

test("presence distinguishes historic daily signals from current observation and unmapped earlier days", () => {
  const data = analytics(), calls = [];
  data.presence = { coverageFrom: "2026-10-02T00:00:00Z", players: 2, onlineSeconds: 75000, flaggedPlayers: 1,
    daily: [{ date: "2026-10-01", players: 0, onlineSeconds: 0, flaggedPlayers: 0 }],
    reviewDays: [{ publicId, displayName: "<Игрок>", date: "2026-10-02", onlineSeconds: 72123, flaggedAt: "2026-10-02T23:50:00Z", watchlisted: false }], reviewDaysTruncated: true };
  const view = inspect(AdminPresenceAnalytics({ data, onOpen: value => calls.push(value.publicId) }));
  for (const text of ["20 ч 2 мин", "Наблюдение снято", "Нет измерений", "100 последних дней", "без блокировки", "прошлое время не восстанавливается"]) assert.ok(view.markup.includes(text), text);
  assert.match(view.markup, /&lt;Игрок&gt;/);
  view.elements.find(node => node.type === "button" && node.props.children === "<Игрок>").props.onClick();
  assert.deepEqual(calls, [publicId]);
});

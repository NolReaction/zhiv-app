import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { WorldHelp } = await vite.ssrLoadModule("/features/world/world-help.tsx");
const { worldHelpTopics, searchWorldHelp } = await vite.ssrLoadModule("/features/world/world-help-content.ts");
const { worldCatalog, newWorldState } = await vite.ssrLoadModule("/features/world/model.ts");
const { CLICKER_IDLE_RESET_MS, CLICKER_LEVELS } = await vite.ssrLoadModule("/features/game/clicker-story.ts");
const { economyCatalog, economyViewSchema } = await vite.ssrLoadModule("/features/economy/model.ts");
const { fishingOdds } = await vite.ssrLoadModule("/features/economy/fishing.ts");

test("help search handles Russian spelling, word order, whitespace and missing results", () => {
  const topics = worldHelpTopics();
  assert.equal(searchWorldHelp(topics, "   "), topics);
  assert.ok(searchWorldHelp(topics, "  ИСКРЫ    лимит  ").some(topic => topic.id === "resources"));
  assert.ok(searchWorldHelp(topics, "подтвержденных").some(topic => topic.id === "level"), "е matches ё in the answer, not just the heading");
  assert.ok(searchWorldHelp(topics, "найти мохлика").some(topic => topic.id === "controls"));
  assert.deepEqual(searchWorldHelp(topics, "несуществующая-тема-12345"), []);
  assert.equal(new Set(topics.map(topic => topic.id)).size, topics.length);
});

test("help uses current catalog rules and marks unavailable mechanics while rebuilding", () => {
  const topics = worldHelpTopics(true), get = id => topics.find(topic => topic.id === id);
  const resources = get("resources").paragraphs.join(" ");
  assert.match(resources, /не более 500 монет, 30 древесины и 30 камня/);
  assert.match(resources, /больше не создают валюту/);
  assert.match(resources, /Покупки за реальные деньги.*не подключены/);
  assert.ok(get("check-in").paragraphs.join(" ").includes(`${CLICKER_IDLE_RESET_MS / 1000} секунд`));
  assert.ok(get("level").paragraphs.join(" ").includes(`уровней ${CLICKER_LEVELS.length}`));
  for (const id of ["explorer_cap", "willow_rod"]) {
    assert.ok(get("collection").paragraphs.join(" ").includes(worldCatalog.items.find(item => item.id === id).name));
  }
  assert.match(get("production").paragraphs[0], /Монеты и материалы списываются при начале работ/);
  assert.match(get("journeys").paragraphs.join("\n"), /Одновременно идёт одно исследование/);
  assert.match(get("market").paragraphs[1], /Свой лот купить нельзя/);
  assert.match(get("wardrobe").note, /Одежда меняет внешность.*снасти выбираются перед вылазкой/);
  assert.match(get("wardrobe").steps.join(" "), /Моих вещах.*Магазине.*монеты или жемчуг.*подтвердить/);
  assert.match(get("collection").paragraphs.join(" "), /Каменоломня.*минерала/);
  assert.match(get("collection").paragraphs.join(" "), /после получения результата.*повторный запрос/);
  assert.match(get("collection").note, /Реликвии.*отдельно в кладовой.*расходуются/);
  assert.doesNotMatch(worldHelpTopics(false).find(topic => topic.id === "journeys").paragraphs.join(" "), /временно недоступны|началось раньше/);
});

test("help directs each map action to its focused menu", () => {
  const topics = worldHelpTopics(), text = id => topics.find(topic => topic.id === id).paragraphs.join(" ");
  assert.match(text("level"), /уровень слева сверху.*профиль.*самочувствие/);
  assert.match(text("resources"), /Кладовая.*отдельное меню запасов/);
  assert.match(text("journeys"), /В путь.*выбор занятий Мохлика/);
  assert.match(text("journeys"), /вход шахты на карте сразу выбирает вкладку «Шахта» во «В путь»/);
  assert.match(text("production"), /Мастерская \/ Печь.*в заголовке.*кнопка «Начать» остаются внизу панели/);
  assert.match(text("construction"), /Таймер находится над улучшаемым объектом/);
  assert.match(text("construction"), /кладовая — над домом, печь — над мастерской, заготовки — над костром/);
  assert.match(text("journeys"), /сектор «Лес», «Побережье» или «Шахта»/);
  assert.match(text("production"), /будущие рецепты свёрнуты в «Позже»/);
  assert.match(text("resources"), /Эффект начинается после подтверждения действия/);
  assert.doesNotMatch(text("resources") + text("journeys"), /Переход из окна дома|В окне дома доступны улучшение и переход|сверху карты виден таймер/);
  assert.match(text("journeys"), /в меню «Ещё» появятся «Старые походы»/);
  assert.match(text("saving"), /профиль кнопкой уровня.*Продолжить здесь/);
  assert.doesNotMatch(topics.flatMap(topic => [...(topic.steps ?? []), ...(topic.paragraphs ?? []), topic.note ?? ""]).join(" "), /Как Мохлик\?/);
});

test("guide separates construction and production while describing released pearl income", () => {
  const topics = worldHelpTopics(), get = id => topics.find(topic => topic.id === id);
  const pearls = get("pearls");
  assert.ok(pearls.steps.join(" ").includes(`${economyCatalog.constructionSpeedup.secondsPerPearl / 60} минут`));
  assert.match(pearls.steps.join(" "), /Подтвердите завершение.*цена снизится.*меньшая сумма.*готова — ничего/);
  assert.match(pearls.note, /только на строительство.*не на производство или вылазки/);
  assert.match(pearls.note, /дождитесь таймера и завершите бесплатно/);
  assert.match(pearls.note, /в подарках за вход и достижениях/);
  assert.match(pearls.note, /Покупка валюты за реальные деньги пока не подключена/);
  assert.match(get("construction").paragraphs.join(" "), /При уменьшении движения/);
  assert.match(get("future-world").paragraphs.join(" "), /Их восстановление.*ещё готовятся/);
  assert.doesNotMatch(topics.flatMap(topic => topic.paragraphs ?? []).join(" "), /ускорения пока не подключены|Жемчуг зарезервирован/);
  assert.deepEqual(searchWorldHelp(topics, "ускорение жемчуг").map(topic => topic.id), ["construction", "pearls"]);
});

test("help has a labelled search, native keyboard-operable topics and current status", () => {
  const markup = renderToStaticMarkup(createElement(WorldHelp));
  const inputId = /<input id="([^"]+)"/.exec(markup)?.[1];
  assert.ok(inputId);
  assert.ok(markup.includes(`for="${inputId}"`));
  assert.match(markup, /role="search" aria-label="Поиск по справке"/);
  assert.match(markup, /aria-label="Состояние игры"/);
  assert.match(markup, /role="status"/);
  assert.equal((markup.match(/<details /g) ?? []).length, worldHelpTopics().length);
  assert.equal((markup.match(/<summary>/g) ?? []).length, worldHelpTopics().length);
  assert.doesNotMatch(markup, /<details[^>]* open=/, "the first visit presents a compact table of contents");
});

test("world HUD keeps help visible and moves secondary actions under More", async () => {
  const { default: WorldView } = await vite.ssrLoadModule("/features/world/world-view.tsx");
  const world = { snapshot: { state: newWorldState(), gifts: [] }, now: Date.parse("2026-09-23T12:00:00Z"), act() {} };
  const markup = renderToStaticMarkup(createElement(WorldView, { world, economy: { snapshot: null, now: world.now }, ownerPublicId: "help-test", timeZone: "UTC", onClose() {}, displayName: "Мохлик", level: 1, wakeSignal: 0, bestStreakDays: 1 }));
  assert.match(markup, /aria-label="Справка по игре"/);
  assert.match(markup, /data-world-quick="more" aria-haspopup="dialog" aria-expanded="false"/);
  assert.match(markup, /aria-label="Открыть кладовую"/);
  assert.doesNotMatch(markup, /aria-label="Открыть коллекции"/);
  assert.match(markup, /aria-label="Профиль Мохлика\. Мохлик, уровень 1"/);
  const dock = /<nav[^>]*aria-label="Действия в игре"[^>]*>([\s\S]*?)<\/nav>/.exec(markup)?.[1];
  assert.ok(dock);
  assert.deepEqual([...dock.matchAll(/data-world-quick="([^"]+)"/g)].map(match => match[1]), ["pantry", "expeditions", "more"]);
  assert.doesNotMatch(markup, /Как Мохлик\?|Хозяйство/);
  assert.match(markup, /lucide-info/);
});


test("pantry shortcut is visible before opening a building and includes reserved storage", async () => {
  const { default: WorldView } = await vite.ssrLoadModule("/features/world/world-view.tsx");
  const world = { snapshot: { state: newWorldState(), gifts: [] }, now: Date.parse("2026-10-03T12:00:00Z"), act() {} };
  const economy = { snapshot: { ownerPublicId: "AAAA-0000-0001", revision: 1, serverTime: new Date(world.now).toISOString(), catalog: economyCatalog,
    wallet: { coins: 150, pearls: 2 }, buildings: { home: 1, warehouse: 1 }, inventory: { wood: 180 }, jobs: [],
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, completedExplorations: 0,
    storage: { used: 180, reserved: 20, capacity: 200, available: 0, overflow: 0 } }, now: world.now };
  economy.snapshot = economyViewSchema.parse(economy.snapshot);
  const markup = renderToStaticMarkup(createElement(WorldView, { world, economy, ownerPublicId: economy.snapshot.ownerPublicId, timeZone: "UTC", onClose() {}, displayName: "Мохлик", level: 1, wakeSignal: 0, bestStreakDays: 1 }));
  assert.match(markup, /aria-label="Кладовая: занято 200 из 200 мест" data-full="true"/);
  assert.match(markup, /<span>Кладовая<\/span>/);
  assert.doesNotMatch(markup, /200 \/ 200/, "capacity stays in the accessible label and pantry rather than enlarging the dock");
  assert.doesNotMatch(markup, /data-upgrade-station/);
});

test("released gift, relic and fish-rarity rules are searchable and match the available catch catalogue", () => {
  const topics = worldHelpTopics(), get = id => topics.find(topic => topic.id === id);
  assert.match(get("rewards").paragraphs.join(" "), /семи шагам.*UTC.*20 часов.*Пропуск сохраняет/);
  assert.match(get("rewards").paragraphs.join(" "), /Забрать подарок.*само по себе ничего не начисляет/);
  assert.match(get("rewards").paragraphs.join(" "), /один раз.*полученные раньше/);
  assert.match(get("relics").paragraphs[0], /Древнее ядро.*Лунный кристалл.*Живая смола/);
  assert.match(get("relics").paragraphs[0], /от 48 до 144 часов/);
  assert.match(get("relics").paragraphs.join(" "), /одну реликвию за одну другую/);
  assert.match(get("plesk").paragraphs.join(" "), /Можно поймать и эпические виды, и легендарную акулу/);
  assert.ok(searchWorldHelp(topics, "подарки жемчуг").some(topic => topic.id === "rewards"));
  assert.ok(searchWorldHelp(topics, "смола обмен").some(topic => topic.id === "relics"));
});

test("food guide separates optional satiety from paid resident orders and required trip provisions", () => {
  const topics = worldHelpTopics(), get = id => topics.find(topic => topic.id === id);
  const meals = get("food").paragraphs.join(" "), orders = get("resident-orders").paragraphs.join(" ");
  for (const meal of economyCatalog.food.meals) {
    const name = economyCatalog.items.find(item => item.id === meal.itemId).name;
    assert.ok(meals.includes(`${name} — +${meal.heroSpeedBps / 100}%`));
  }
  assert.match(meals, /одну порцию.*Мохлик получает бонус скорости на следующую вылазку или рыбалку/);
  assert.match(meals, /Шишколапу \+10%.*сокращает только оставшееся время.*повторно нельзя/);
  assert.match(meals, /не пропадают за время отсутствия.*Обязательного голода нет/);
  assert.match(meals, /Количество добычи и шансы редкой рыбы от еды не меняются/);
  assert.match(meals, /отмена похода обед не возвращает.*не заменяет обязательные припасы/);
  assert.match(orders, /приносят только монеты.*не кормит.*обед выбирается отдельно/);
  const board = economyCatalog.food.orders;
  assert.ok(orders.includes(`На доске ${board.slots} заказа`));
  assert.ok(orders.includes(`каждые ${board.refreshSeconds / 3600} часов`));
  assert.ok(orders.includes(`через ${board.replacementSeconds / 60} минут`));
  assert.ok(orders.includes(`через ${board.completionSeconds / 60} минут`));
  assert.match(orders, /не резервируются.*бесплатно заменить.*ожидание.*раньше/);
  assert.match(get("campfire").paragraphs.join(" "), /редкий улов не подставляется автоматически.*остаётся открытым/);
  assert.ok(searchWorldHelp(topics, "сытость").some(topic => topic.id === "food"));
  assert.ok(searchWorldHelp(topics, "заменить заказ").some(topic => topic.id === "resident-orders"));
});

test("guide explains the actual top legendary chance per special attempt without promising a full catch", () => {
  const fishing = economyCatalog.fishing;
  const probability = fishingOdds({}, fishing, { rodId: "starfall_rod", hookId: "leviathan_hook", baitId: "firefly_bait" })
    .filter(odds => fishing.fish.some(fish => fish.itemId === odds.itemId && fish.rarity === "legendary"))
    .reduce((sum, odds) => sum + odds.probability, 0);
  const guide = worldHelpTopics().find(topic => topic.id === "plesk").paragraphs.join(" ");
  assert.ok(guide.includes(`${(probability * 100).toFixed(2).replace(".", ",")}% на легендарную рыбу за одну особую попытку`));
  assert.match(guide, /Звёздная удочка, Крючок Левиафана и Искристая мушка/);
  assert.match(guide, /гарантированная речная рыба.*не превращается в дополнительные броски/);
});

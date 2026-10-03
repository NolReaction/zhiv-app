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
  assert.match(get("journeys").paragraphs[0], /Монеты и материалы списываются при начале работ/);
  assert.match(get("journeys").paragraphs.join("\n"), /Одновременно идёт одно исследование/);
  assert.match(get("market").paragraphs[1], /Свой лот купить нельзя/);
  assert.match(get("wardrobe").note, /пока нельзя изготовить.*полученные вещи можно менять/);
  assert.match(get("collection").note, /Новые исследования дают товары на склад/);
  assert.doesNotMatch(worldHelpTopics(false).find(topic => topic.id === "journeys").paragraphs.join(" "), /временно недоступны|началось раньше/);
});

test("help directs each map action to its focused menu", () => {
  const topics = worldHelpTopics(), text = id => topics.find(topic => topic.id === id).paragraphs.join(" ");
  assert.match(text("level"), /уровень слева сверху.*профиль.*самочувствие/);
  assert.match(text("resources"), /Кладовая.*отдельное меню запасов/);
  assert.match(text("journeys"), /В путь.*только исследования/);
  assert.match(text("journeys"), /Таймер находится над улучшаемым объектом/);
  assert.match(text("journeys"), /кладовая — над домом, печь — над мастерской, заготовки — над костром/);
  assert.match(text("journeys"), /сектор «Лес», «Побережье» или «Пещеры»/);
  assert.match(text("journeys"), /будущие рецепты свёрнуты в «Позже»/);
  assert.match(text("resources"), /Эффект начинается после подтверждения действия/);
  assert.doesNotMatch(text("resources") + text("journeys"), /Переход из окна дома|В окне дома доступны улучшение и переход|сверху карты виден таймер/);
  assert.match(text("journeys"), /в меню «Ещё» появятся «Старые походы»/);
  assert.match(text("saving"), /профиль кнопкой уровня.*Продолжить здесь/);
  assert.doesNotMatch(topics.flatMap(topic => [...(topic.steps ?? []), ...(topic.paragraphs ?? []), topic.note ?? ""]).join(" "), /Как Мохлик\?/);
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
  const economy = { snapshot: { wallet: { coins: 150, pearls: 2 }, buildings: { home: 1, warehouse: 1 }, jobs: [], storage: { used: 180, reserved: 20, capacity: 200, available: 0, overflow: 0 } }, now: world.now };
  const markup = renderToStaticMarkup(createElement(WorldView, { world, economy, ownerPublicId: "pantry-test", timeZone: "UTC", onClose() {}, displayName: "Мохлик", level: 1, wakeSignal: 0, bestStreakDays: 1 }));
  assert.match(markup, /aria-label="Кладовая: занято 200 из 200 мест" data-full="true"/);
  assert.match(markup, /<span>Кладовая<\/span>/);
  assert.doesNotMatch(markup, /200 \/ 200/, "capacity stays in the accessible label and pantry rather than enlarging the dock");
  assert.doesNotMatch(markup, /data-upgrade-station/);
});

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
  assert.ok(resources.includes(`Каждые ${worldCatalog.tapsPerSpark} засчитанных`));
  assert.ok(resources.includes(`до ${worldCatalog.dailySparkLimit} искр`));
  assert.match(resources, /00:00 UTC/);
  assert.ok(get("check-in").paragraphs.join(" ").includes(`${CLICKER_IDLE_RESET_MS / 1000} секунд`));
  assert.ok(get("level").paragraphs.join(" ").includes(`уровней ${CLICKER_LEVELS.length}`));
  for (const id of ["explorer_cap", "willow_rod"]) {
    assert.ok(get("collection").paragraphs.join(" ").includes(worldCatalog.items.find(item => item.id === id).name));
  }
  assert.match(get("journeys").paragraphs[0], /Новые прогулки, рыбалка, строительство, улучшения и изготовление вещей временно недоступны/);
  assert.match(get("journeys").paragraphs[1], /раньше.*В пути.*Подтвердить возвращение/);
  assert.match(get("wardrobe").note, /пока нельзя изготовить.*полученные вещи можно менять/);
  assert.match(get("collection").note, /новые выходы пока закрыты/);
  assert.doesNotMatch(worldHelpTopics(false).find(topic => topic.id === "journeys").paragraphs.join(" "), /временно недоступны|началось раньше/);
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

test("world HUD places the labelled info action directly after collections", async () => {
  const { default: WorldView } = await vite.ssrLoadModule("/features/world/world-view.tsx");
  const world = { snapshot: { state: newWorldState(), gifts: [] }, now: Date.parse("2026-09-23T12:00:00Z"), act() {} };
  const markup = renderToStaticMarkup(createElement(WorldView, { world, ownerPublicId: "help-test", timeZone: "UTC", onClose() {}, displayName: "Мохлик", level: 1, wakeSignal: 0, bestStreakDays: 1 }));
  assert.match(markup, /aria-label="Открыть коллекции"[^]*?<\/button><button[^>]*aria-label="Справка по игре"/);
  assert.match(markup, /lucide-info/);
});

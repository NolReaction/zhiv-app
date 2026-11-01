import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { GameLevelsPanel, PLAYER_LEVEL_GROUPS, getLevelGroupIndex } = await vite.ssrLoadModule("/features/game/game-levels-button.tsx");
const { PlayerProgressionCard, CooperationSeasonCard } = await vite.ssrLoadModule("/features/game/player-progression-card.tsx");
const { PLAYER_LEVELS, PLAYER_ICON_LEVELS, getPlayerLevel } = await vite.ssrLoadModule("/features/economy/domain/player-progression.ts");
const now = Date.parse("2026-11-01T12:00:00Z");
const progression = (xp, patch = {}) => ({ routes: {}, recipes: {}, collections: { finds: [], travelSeconds: 0, quarrySeconds: 0 }, player: {
  version: 1, xp, workSeconds: 0, awardedLevels: [], badges: [], pendingPearls: 0,
  season: { id: "2026-11", points: 0, awardedMilestones: [] }, ...patch,
} });
function renderComponent(Component, props) {
  const elements = [];
  function capture(element) {
    if (!isValidElement(element)) return;
    elements.push(element);
    Children.forEach(element.props.children, capture);
  }
  function Probe() { const element = Component(props); capture(element); return element; }
  return { markup: renderToStaticMarkup(createElement(Probe)), elements };
}
function renderPanel(xp, groupIndex = getLevelGroupIndex(getPlayerLevel(xp).level)) {
  const actions = [];
  return { ...renderComponent(GameLevelsPanel, { progression: progression(xp), now, groupIndex, onGroupChange: index => actions.push(index) }), actions };
}

test("XP level groups cover 1–100 exactly once and render ten rows at each boundary", () => {
  assert.equal(PLAYER_LEVEL_GROUPS.length, 10);
  assert.deepEqual(PLAYER_LEVEL_GROUPS.flatMap(group => group.levels.map(level => level.level)), PLAYER_LEVELS.map(level => level.level));
  for (const group of PLAYER_LEVEL_GROUPS) {
    assert.equal(group.levels.length, 10);
    for (const level of [group.levels[0], group.levels.at(-1)]) {
      const { markup, elements } = renderPanel(level.minimumXp);
      assert.equal(getLevelGroupIndex(level.level), group.index);
      const rows = elements.filter(element => element.type === "li");
      assert.equal(rows.length, 10);
      assert.equal(rows.filter(row => row.props["aria-current"] === "step").length, 1);
      assert.match(markup, new RegExp(`aria-label="Уровни ${group.label}"`));
      assert.equal(elements.find(element => element.type === "select").props.value, group.index);
      assert.doesNotMatch(markup, /подтверждённых тапов|тапов до уровня/);
    }
  }
});

test("profile progress uses only confirmed XP including the cap and never invents a loaded value", () => {
  for (const [xp, percent, text] of [
    [0, 0, "До уровня 2: 50 XP"], [25, 50, "До уровня 2: 25 XP"], [49, 98, "До уровня 2: 1 XP"],
    [50, 0, "До уровня 3: 150 XP"], [125, 50, "До уровня 3: 75 XP"],
    [PLAYER_LEVELS.at(-1).minimumXp, 100, "Все уровни открыты"], [Number.MAX_SAFE_INTEGER, 100, "Все уровни открыты"],
  ]) {
    const { elements, markup } = renderComponent(PlayerProgressionCard, { progression: progression(xp), now });
    const progress = elements.find(element => element.props.role === "progressbar");
    assert.equal(progress.props["aria-valuenow"], percent);
    assert.equal(progress.props["aria-valuetext"], text);
    assert.match(markup, new RegExp(text));
    assert.doesNotMatch(markup, /До уровня 101|NaN|Infinity/);
  }
  const loading = renderComponent(PlayerProgressionCard, { progression: null, now }).markup;
  assert.match(loading, /Загружаем игровой опыт/);
  assert.doesNotMatch(loading, /всего XP|Уровень <strong>/);
});

test("icon stages inspect locked groups without unlocking or changing player XP", () => {
  const { elements, actions } = renderPanel(PLAYER_LEVELS[74].minimumXp);
  const stages = elements.filter(element => element.type === "button");
  assert.equal(stages.length, PLAYER_ICON_LEVELS.length);
  stages.forEach((stage, index) => {
    const level = PLAYER_ICON_LEVELS[index];
    assert.match(stage.props["aria-label"], new RegExp(`Значок уровня ${level}:`));
    assert.equal(Boolean(stage.props["data-unlocked"]), level <= 75);
    assert.equal(stage.props["aria-current"], level === 70 ? "step" : undefined);
    stage.props.onClick();
    assert.equal(actions.at(-1), getLevelGroupIndex(level));
  });
  const { elements: lockedGroup } = renderPanel(0, actions.at(-1));
  assert.ok(lockedGroup.filter(element => element.type === "li").every(row => row.props["data-earned"] === undefined));
});

test("level group selector remains keyboard-native and announces the selected range", () => {
  const { elements, actions } = renderPanel(0);
  const select = elements.find(element => element.type === "select");
  assert.ok(elements.some(element => element.type === "label" && element.props.htmlFor === select.props.id));
  select.props.onChange({ target: { value: "5" } });
  assert.deepEqual(actions, [5]);
  const { markup, elements: next } = renderPanel(0, actions[0]);
  assert.match(markup, /aria-label="Уровни 51–60"/);
  assert.equal(next.filter(element => element.type === "li").length, 10);
  assert.ok(next.find(element => element.props["aria-live"] === "polite"));
});

test("profile names the actual last XP source and next catalog reward without mutating it", () => {
  const value = progression(PLAYER_LEVELS[9].minimumXp, { lastAward: { xp: 300, source: "construction", at: new Date(now).toISOString() } });
  const before = structuredClone(value);
  const html = renderComponent(PlayerProgressionCard, { progression: value, now }).markup;
  assert.match(html, /\+300 XP/); assert.match(html, /Строительство/); assert.match(html, /На уровне 20/); assert.match(html, /5 жемч/);
  assert.deepEqual(value, before);
});

test("season rotates in UTC without erasing career XP or showing last month's awarded milestones", () => {
  const value = progression(200, { season: { id: "2026-10", points: 700, awardedMilestones: [100, 300, 700] } });
  const before = structuredClone(value);
  const oldMonth = renderComponent(CooperationSeasonCard, { progression: value, now: Date.parse("2026-10-31T23:59:59Z") });
  assert.match(oldMonth.markup, /Все цели месяца выполнены/);
  const newMonth = renderComponent(CooperationSeasonCard, { progression: value, now });
  assert.match(newMonth.markup, /Подготовка к зиме/);
  assert.match(newMonth.markup, /00:00 UTC/);
  assert.doesNotMatch(newMonth.markup, /data-earned="true"/);
  assert.equal(newMonth.elements.find(element => element.props.role === "progressbar").props["aria-valuenow"], 0);
  assert.deepEqual(value, before);
});

test("earned season badges remain visible after rollover and absent clock has a finite fallback", () => {
  const value = progression(200, { badges: ["2026-10:helper", "2026-10:friend"],
    season: { id: "2026-10", points: 700, awardedMilestones: [100, 300, 700] } });
  const html = renderComponent(CooperationSeasonCard, { progression: value, now }).markup;
  assert.match(html, /Полученные сезонные значки/);
  assert.match(html, /Память о сезонах · 2/);
  assert.match(html, /октябрь 2026/);
  const fallback = renderComponent(CooperationSeasonCard, { progression: value }).markup;
  assert.doesNotMatch(fallback, /NaN|Invalid Date|undefined/);
});

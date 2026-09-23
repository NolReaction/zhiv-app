import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { GameLevelsPanel, CLICKER_LEVEL_GROUPS, getLevelGroupIndex } = await vite.ssrLoadModule("/features/game/game-levels-button.tsx");
const { CLICKER_LEVELS, CLICKER_ICON_LEVELS, getClickerLevel } = await vite.ssrLoadModule("/features/game/clicker-story.ts");

function renderPanel(lifetimeTaps, groupIndex = getLevelGroupIndex(getClickerLevel(lifetimeTaps).level)) {
  const actions = [], elements = [];
  function capture(element) {
    if (!isValidElement(element)) return;
    elements.push(element);
    Children.forEach(element.props.children, capture);
  }
  function Panel() {
    const element = GameLevelsPanel({ lifetimeTaps, groupIndex, onGroupChange: index => actions.push(index) });
    capture(element);
    return element;
  }
  const markup = renderToStaticMarkup(createElement(Panel));
  return { markup, elements, actions };
}

// Every boundary is derived from the actual progression table; no alternate economy in the UI.
test("level groups cover 1–100 exactly once and render ten rows around every boundary", () => {
  assert.equal(CLICKER_LEVEL_GROUPS.length, 10);
  assert.deepEqual(CLICKER_LEVEL_GROUPS.flatMap(group => group.levels.map(level => level.level)), CLICKER_LEVELS.map(level => level.level));
  for (const group of CLICKER_LEVEL_GROUPS) {
    assert.equal(group.levels.length, 10);
    for (const level of [group.levels[0], group.levels.at(-1)]) {
      const { markup, elements } = renderPanel(level.minimumLifetimeTaps);
      assert.equal(getLevelGroupIndex(level.level), group.index);
      const rows = elements.filter(element => element.type === "li");
      assert.equal(rows.length, 10);
      assert.equal(rows.filter(row => row.props["aria-current"] === "step").length, 1);
      assert.match(markup, new RegExp(`aria-label="Уровни ${group.label}"`));
      assert.equal(elements.find(element => element.type === "select").props.value, group.index);
    }
  }
});

test("progress shows the remaining confirmed taps within the current level, including the cap", () => {
  for (const [taps, percent, text] of [
    [0, 0, "До уровня 2: 10 тапов"],
    [4, 40, "До уровня 2: 6 тапов"],
    [9, 90, "До уровня 2: 1 тап"],
    [10, 0, "До уровня 3: 15 тапов"],
    [22, 80, "До уровня 3: 3 тапа"],
    [1_231_250, 100, "Все уровни открыты"],
    [Number.MAX_SAFE_INTEGER, 100, "Все уровни открыты"],
  ]) {
    const { elements, markup } = renderPanel(taps);
    const progress = elements.find(element => element.props.role === "progressbar");
    assert.equal(progress.props["aria-valuenow"], percent);
    assert.equal(progress.props["aria-valuetext"], text);
    assert.match(markup, new RegExp(text));
    assert.doesNotMatch(markup, /До уровня 101|NaN|Infinity/);
  }
});

test("icon stages show real milestone icons and locked stages can be inspected without unlocking", () => {
  const { elements, actions } = renderPanel(CLICKER_LEVELS[74].minimumLifetimeTaps);
  const stages = elements.filter(element => element.type === "button");
  assert.equal(stages.length, CLICKER_ICON_LEVELS.length);
  stages.forEach((stage, index) => {
    const level = CLICKER_ICON_LEVELS[index];
    assert.match(stage.props["aria-label"], new RegExp(`Значок уровня ${level}:`));
    assert.equal(Boolean(stage.props["data-unlocked"]), level <= 75);
    assert.equal(stage.props["aria-current"], level === 75 ? "step" : undefined);
    stage.props.onClick();
    assert.equal(actions.at(-1), getLevelGroupIndex(level));
  });
  const { elements: lockedGroup } = renderPanel(0, actions.at(-1));
  const rows = lockedGroup.filter(element => element.type === "li");
  assert.equal(rows.length, 10);
  assert.ok(rows.every(row => row.props["data-earned"] === undefined));
  assert.equal(lockedGroup.find(element => element.props.role === "progressbar").props["aria-valuetext"], "До уровня 2: 10 тапов");
});

test("group selector stays keyboard-native, labelled, and replaces the rendered range", () => {
  const { elements, actions } = renderPanel(0);
  const select = elements.find(element => element.type === "select");
  assert.ok(elements.some(element => element.type === "label" && element.props.htmlFor === select.props.id));
  select.props.onChange({ target: { value: "5" } });
  assert.deepEqual(actions, [5]);
  const { markup, elements: next } = renderPanel(0, actions[0]);
  assert.match(markup, /aria-label="Уровни 51–60"/);
  assert.equal(next.filter(element => element.type === "li").length, 10);
  assert.doesNotMatch(markup, /<strong>1\. Новичок/);
  const announcement = next.find(element => element.props["aria-live"] === "polite");
  assert.ok(announcement, "range change must be announced when a milestone changes the group");
});

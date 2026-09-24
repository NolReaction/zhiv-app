import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { MochlikState, MochlikStateDetails } = await vite.ssrLoadModule("/features/world/mochlik-state.tsx");

const observation = {
  activity: "Исследует полянку", detail: "Заметил интересное место и идёт посмотреть поближе.", mood: "Любопытничает",
  needs: { energy: .8, curiosity: .7, comfort: .9, attention: 0 }, sleeping: false, paused: false,
  memory: { status: "saved", savedAt: 1_000 },
  diagnostics: { reason: "debug-private-reason", candidates: [{ id: "hidden-id", label: "Hidden action", score: 4.9763, available: true, reason: "internal-choice" }], events: [] },
};
const render = value => renderToStaticMarkup(createElement(MochlikStateDetails, { observation: value }));

test("character details describe the current activity and feelings without exposing AI scoring", () => {
  const markup = render(observation);
  for (const text of [observation.activity, observation.detail, observation.mood, "Полон сил", "Хочется открытий", "Чувствует себя уютно", "Занят своими делами"]) assert.ok(markup.includes(text));
  assert.doesNotMatch(markup, /debug-private-reason|hidden-id|Hidden action|4\.9763|internal-choice|Utility|progressbar|aria-live/);
  assert.match(markup, /Самочувствие Мохлика/);
  assert.match(markup, /не требует расписания/);
});

test("attention describes a recent player interaction and low energy describes rest", () => {
  const markup = render({ ...observation, activity: "Отдыхает", sleeping: true,
    needs: { energy: .1, curiosity: .1, comfort: .2, attention: 1 } });
  for (const text of ["Отдыхает", "Пора передохнуть", "Уже нагулялся", "Ищет место поуютнее", "Рад тебя видеть"]) assert.ok(markup.includes(text));
  assert.doesNotMatch(markup, /Занят своими делами|Полон сил/);
});

test("missing state remains truthful and saved memory is explicitly device-local", () => {
  assert.match(render(null), /Состояние появится, когда полянка загрузится/);
  assert.doesNotMatch(render(null), /Полон сил|Исследует|сохраня/);
  for (const status of ["saved", "restored"]) {
    const markup = render({ ...observation, memory: { status, savedAt: 1_000 } });
    assert.match(markup, /помнит свои занятия и отдых на этом устройстве/);
    assert.match(markup, /На другом устройстве у него своя жизнь/);
  }
  assert.match(render({ ...observation, memory: { status: "session", savedAt: null } }), /только на время этой сессии/);
  assert.match(render({ ...observation, memory: { status: "unavailable", savedAt: null } }), /не получается сохранить память/);
  assert.match(render({ ...observation, memory: { status: "unavailable", savedAt: null } }), /жизнь полянки продолжается/);
});

test("switching accounts remounts the dialog and initial trigger has an accessible target", () => {
  const first = MochlikState({ presenceKey: "zhiv:mochlik:presence:first" });
  const second = MochlikState({ presenceKey: "zhiv:mochlik:presence:second" });
  assert.notEqual(first.key, second.key);
  const markup = renderToStaticMarkup(createElement(MochlikState, { presenceKey: "zhiv:mochlik:presence:first" }));
  assert.match(markup, /aria-haspopup="dialog"/);
  assert.match(markup, /aria-label="Мохлик: Ждём полянку…\. Посмотреть состояние"/);
  assert.doesNotMatch(markup, /aria-live/);
});

test("status trigger cannot count a game tap and the world camera measures its HUD space", async () => {
  for (const [path, world] of [["features/check-in/check-in-app.tsx", false], ["features/world/world-view.tsx", true]]) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let found = false;
    const visit = node => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === "MochlikState") {
        found = true;
        const ancestors = [];
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (ts.isJsxElement(parent)) ancestors.push(parent.openingElement);
        }
        assert.ok(ancestors.every(element => element.tagName.getText(tree) !== "button"), "no nested interactive control");
        assert.ok(ancestors.every(element => !element.attributes.getText(tree).includes("handleGameAreaPointerDown")), "status taps must stay outside the game tap handler");
        if (world) assert.ok(ancestors.some(element => element.attributes.getText(tree).includes("ref={bottomHud}")), "camera must reserve room for the visible status");
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    assert.equal(found, true);
  }
});

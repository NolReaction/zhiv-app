import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { ForestAiDiagnostics, createForestAiReport, decisionTime } = await vite.ssrLoadModule("/features/world/dev/forest-ai-diagnostics.tsx");

const observation = () => ({
  activity: "Идёт к грибу", detail: "Заметил находку и выбрал безопасный подход", mood: "Любопытствует",
  needs: { energy: .73, curiosity: .82, comfort: .64, attention: .25 }, sleeping: false, paused: false,
  memory: { status: "restored", savedAt: Date.UTC(2026, 8, 24, 10, 20, 30) },
  diagnostics: {
    reason: "Гриб рядом, энергии хватает",
    candidates: [
      { id: "butterfly", label: "Поиграть с бабочкой", score: 100, available: false, reason: "Рядом нет свободной бабочки" },
      { id: "rest", label: "Отдохнуть", score: -1.2, available: true, reason: "Пока полон сил" },
      { id: "mushroom", label: "Посмотреть гриб", score: 3.75, available: true, reason: "Интересная находка рядом" },
    ],
    events: [
      { id: 1, at: 15, type: "decision", label: "Выбрал гриб", reason: "Гриб рядом" },
      { id: 2, at: 65.6, type: "movement", label: "Начал подход", reason: "Путь свободен" },
    ],
  },
});

function render(observation, onExport) {
  const elements = [];
  function capture(element) {
    if (!isValidElement(element)) return;
    elements.push(element);
    Children.forEach(element.props.children, capture);
  }
  const element = ForestAiDiagnostics({ observation, onExport });
  capture(element);
  return { markup: renderToStaticMarkup(element), elements };
}

test("DEV explains blocked alternatives and chronological events without changing the observation", () => {
  const snapshot = observation(), before = structuredClone(snapshot);
  const { markup, elements } = render(snapshot);
  assert.match(markup, /Гриб рядом, энергии хватает/);
  assert.match(markup, /Рядом нет свободной бабочки/);
  assert.match(markup, /полезность занятия, а не вероятность/);
  assert.ok(markup.indexOf("Посмотреть гриб") < markup.indexOf("Отдохнуть"));
  assert.ok(markup.indexOf("Отдохнуть") < markup.indexOf("Поиграть с бабочкой"), "blocked high scores do not look like a winner");
  assert.match(markup, /-1\.20/);
  assert.ok(markup.indexOf("Начал подход") < markup.indexOf("Выбрал гриб"), "latest decision is first");
  assert.match(markup, /1:05 от начала симуляции/);
  assert.equal(elements.filter(element => element.type === "meter").length, 4);
  assert.deepEqual(snapshot, before, "render must not reorder the store snapshot");
});

test("DEV shows a harmless loading state, paused state and unavailable local memory", () => {
  const empty = render(null, () => assert.fail("no export before a scene exists"));
  assert.match(empty.markup, /Данные появятся/);
  assert.equal(empty.elements.filter(element => element.type === "button").length, 0);
  const snapshot = observation();
  snapshot.paused = true;
  snapshot.memory = { status: "unavailable", savedAt: null };
  snapshot.diagnostics = { reason: "", candidates: [], events: [] };
  const { markup } = render(snapshot);
  assert.match(markup, /Пауза/);
  assert.match(markup, /Хранилище недоступно/);
  assert.match(markup, /ещё не выбирал новое занятие/);
  assert.doesNotMatch(markup, /Последняя запись|Invalid Date|NaN/);
});

test("need meters stay labelled and bounded, export is explicit and saved time is machine-readable", () => {
  const snapshot = observation();
  snapshot.needs = { energy: 2, curiosity: -.4, comfort: NaN, attention: .253 };
  let exports = 0;
  const { markup, elements } = render(snapshot, () => exports++);
  const meters = elements.filter(element => element.type === "meter");
  assert.deepEqual(meters.map(element => [element.props["aria-label"], element.props.value]),
    [["Энергия", 100], ["Любопытство", 0], ["Комфорт", 0], ["Внимание к игроку", 25]]);
  assert.match(markup, /dateTime="2026-09-24T10:20:30\.000Z"/i);
  elements.find(element => element.type === "button").props.onClick();
  assert.equal(exports, 1);
  assert.equal(decisionTime(NaN), "0:00");
  assert.equal(decisionTime(-20), "0:00");
});

test("JSON report is a bounded allowlisted snapshot, never an account or full session export", () => {
  const snapshot = observation();
  snapshot.ownerPublicId = "private-account";
  snapshot.sessionToken = "secret-token";
  snapshot.needs.token = "secret-token";
  snapshot.memory.rawStorage = "account-history";
  snapshot.diagnostics.candidates = Array.from({ length: 70 }, (_, index) => ({
    id: `candidate-${index}`, label: "x".repeat(600), score: index, available: true, reason: "available", token: "secret-token",
  }));
  snapshot.diagnostics.events = Array.from({ length: 70 }, (_, index) => ({
    id: index, at: index * 2, type: "decision", label: "New goal", reason: "Interesting", accountId: "private-account",
  }));
  const report = createForestAiReport(snapshot, Date.UTC(2026, 8, 24));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, "forest-ai-observation");
  assert.equal(report.exportedAt, "2026-09-24T00:00:00.000Z");
  assert.equal(report.diagnostics.candidates.length, 32);
  assert.equal(report.diagnostics.candidates[0].label.length, 512);
  assert.equal(report.diagnostics.events.length, 24);
  assert.equal(report.diagnostics.events[0].id, 46);
  assert.equal(report.diagnostics.events.at(-1).id, 69);
  assert.doesNotMatch(JSON.stringify(report), /private-account|secret-token|account-history|rawStorage/);
  assert.match(report.note, /Не содержит записи для воспроизведения/);
  report.diagnostics.events[0].label = "Modified export";
  assert.equal(snapshot.diagnostics.events[46].label, "New goal");
});

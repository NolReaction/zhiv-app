import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: "/tmp/zhiv-fish-commerce-guides-sections-vite", server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { sectionGuideIds, sectionGuideLessons, sectionGuideCanOpen, parseSectionGuideProgress, transitionSectionGuide: move } = await vite.ssrLoadModule("/features/onboarding/section-guide-model.ts");
const { sectionGuideStorageKey, createSectionGuideStore } = await vite.ssrLoadModule("/features/onboarding/section-guide-storage.ts");
const { requestSectionGuideNavigation, listenForSectionGuideNavigation } = await vite.ssrLoadModule("/features/onboarding/section-guide-navigation.ts");
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function finished(section) {
  let progress = move(section, null, "start");
  for (let index = 0; index < sectionGuideLessons[section].length; index++) progress = move(section, progress, "next");
  return progress;
}

test("each first-entry lesson is short and gating does not consume an unopened lesson", () => {
  for (const section of sectionGuideIds) {
    const steps = sectionGuideLessons[section];
    assert.ok(steps.length >= 2 && steps.length <= (section === "plesk" ? 6 : 3));
    assert.equal(new Set(steps.map(step => step.id)).size, steps.length);
  }
  assert.equal(sectionGuideCanOpen(false, true, null), false, "storage must be loaded first");
  assert.equal(sectionGuideCanOpen(true, false, null), false, "initial course, another device or hidden scope blocks auto-open");
  assert.equal(sectionGuideCanOpen(true, true, null), true, "still eligible when that blocker clears");
});

test("workshop lessons explain direct cards and same-cell cancellation without preparation controls", () => {
  const [recipes, queue] = sectionGuideLessons.workshop;
  assert.match(recipes.summary, /Нажатие сразу начнёт/);
  assert.match(recipes.text, /недостающие материалы показаны прямо в карточке/);
  assert.ok(queue.targets.includes("[data-recipe-order]"), "the one-tap card is itself the action target");
  assert.match(queue.text, /«Удалить\?» и таймер 5 секунд/);
  assert.match(queue.text, /без второго нажатия она продолжится/);
  for (const step of [recipes, queue]) {
    assert.doesNotMatch(`${step.summary} ${step.text}`, /«Начать»|количество партий/);
    assert.ok(step.targets.every(selector => !selector.includes("recipe-preparation")));
    assert.notEqual(step.revealOnOpen, true, "a workshop explanation must never activate a production card");
  }
});

test("expedition lessons keep safe route selectors and direct mining to its separate menu", () => {
  const [routes, preparation] = sectionGuideLessons.expeditions;
  assert.match(routes.summary, /Шахта открывается отдельно на карте/);
  assert.match(routes.text, /само по себе не отправляет в путь/);
  for (const step of [routes, preparation]) {
    assert.ok(step.targets.includes("[data-route]"));
    assert.ok(step.targets.includes('[data-section-guide-target="expedition-routes"]'));
    assert.notEqual(step.revealOnOpen, true, "the coach must not activate a route card");
  }
});

test("travel and meal lessons explain a named optional boost without automatic eating", () => {
  const preparation = sectionGuideLessons.expeditions.find(step => step.id === "preparation");
  const portion = sectionGuideLessons.meals.find(step => step.id === "portion");
  assert.match(preparation.summary, /«Ускорение едой» под таймером/);
  assert.match(preparation.summary, /он необязателен/);
  assert.match(preparation.text, /«Выбрать блюдо».*не тратя еду/);
  assert.match(preparation.text, /только после «Съесть 1»/);
  assert.match(portion.text, /блок «Ускорение едой».*«Выбрать блюдо»/);
  assert.match(portion.text, /не потратив порцию/);
  for (const step of [preparation, portion]) {
    assert.doesNotMatch(step.text, /Кнопка «Еда» рядом/);
    assert.notEqual(step.revealOnOpen, true, "opening a lesson must not choose or consume a dish");
  }
});

test("leaving the section without explicitly pausing its lesson resumes the exact step", () => {
  const disk = storage(), first = createSectionGuideStore("resume-owner", "plesk", disk);
  first.restore();
  first.save(move("plesk", move("plesk", null, "start"), "next"));
  const reopened = createSectionGuideStore("resume-owner", "plesk", disk);
  assert.equal(reopened.getSnapshot().loaded, false);
  reopened.restore();
  assert.equal(reopened.getSnapshot().progress.stepId, "hook-intro");
  assert.equal(sectionGuideCanOpen(true, true, reopened.getSnapshot().progress), true);
});

test("Plesk explains permanent tackle and consumable bait before automatically revealing odds", () => {
  let progress = move("plesk", null, "start");
  for (const expected of ["rod-intro", "hook-intro", "bait-intro"]) {
    assert.equal(progress.stepId, expected);
    const lesson = sectionGuideLessons.plesk.find(step => step.id === progress.stepId);
    assert.notEqual(lesson.revealOnOpen, true, "an introduction must not jump to the probability table");
    assert.ok(lesson.targets.every(selector => !selector.includes("odds")));
    progress = move("plesk", progress, "next");
  }
  for (const expected of ["rods", "bait"]) {
    assert.equal(progress.stepId, expected);
    assert.equal(sectionGuideLessons.plesk.find(step => step.id === expected).revealOnOpen, true);
    progress = move("plesk", progress, "next");
  }
  assert.equal(progress.stepId, "catch");
  const saved = { version: 1, status: "paused", stepId: "bait" };
  assert.deepEqual(parseSectionGuideProgress(JSON.stringify(saved), "plesk"), saved, "existing progress remains resumable");
});

test("Plesk lessons compare class odds without buying and keep representative artwork separate from stock", () => {
  const lesson = id => sectionGuideLessons.plesk.find(step => step.id === id);
  for (const id of ["rods", "bait"]) {
    assert.match(lesson(id).summary, /Пять строк|пяти строк/);
    assert.match(lesson(id).text, /[Оо]ткрытие таблицы не покупает|[Пп]росмотр ничего не покупает/);
  }
  assert.match(lesson("catch").text, /После возвращения.*виды и редкость/);
  assert.match(lesson("catch").text, /«Забрать».*текущий запас.*виды откроются в книге навсегда/);
  assert.match(lesson("catch").text, /оставшихся видов.*Книга помнит и уже потраченные поимки/);
  const queue = sectionGuideLessons.workshop.find(step => step.id === "queue");
  assert.match(queue.text, /Ячейки остаются одинакового размера/);
  assert.match(queue.text, /обе очереди мастерской, «Верстак» и «Печь»/);
});

test("order and travel lessons separate fish selection from consumption and owned gear from buying", () => {
  const [requirements, reward] = sectionGuideLessons.orders;
  assert.match(requirements.text, /выбор оставшихся видов: он уже заполнен/);
  assert.match(reward.text, /тап заменяет рыбу, минус убирает одну/);
  assert.match(reward.text, /Только «Отдать заказ».*потратит рыбу/);
  assert.match(reward.text, /Закрытие ничего не расходует/);
  const preparation = sectionGuideLessons.expeditions.find(step => step.id === "preparation");
  assert.match(preparation.text, /три ячейки: удочка, крючок и наживка/);
  assert.match(preparation.text, /твою снасть без покупки и отправления/);
  assert.match(preparation.text, /Наживка уйдёт только при выходе/);
  for (const step of [requirements, reward, preparation]) assert.notEqual(step.revealOnOpen, true);
});

test("pantry, Plesk and market lessons show species without automatically selling or listing", () => {
  const items = sectionGuideLessons.pantry.find(step => step.id === "items");
  const sale = sectionGuideLessons.pantry.find(step => step.id === "sale");
  const sell = sectionGuideLessons.market.find(step => step.id === "sell");
  const fish = sectionGuideLessons.plesk.find(step => step.id === "catch");
  assert.match(items.text, /«Холодильнике» класс рыбы сначала раскрывает оставшиеся виды/);
  assert.match(items.text, /Просмотр ничего не продаёт/);
  assert.match(sale.text, /только после нажатия кнопки «Продать торговцу»/);
  assert.match(sale.text, /«Без указания вида»/);
  assert.match(sell.text, /выбор оставшихся видов.*«Выставить лот»/);
  assert.match(sell.text, /Просмотр ничего не выставляет/);
  assert.match(fish.summary, /Продажу подтверждает кнопка «Продать»/);
  assert.match(sectionGuideLessons.workshop.find(step => step.id === "queue").text, /Таймер меняется по секундам/);
  for (const step of [items, sale, sell, fish]) assert.notEqual(step.revealOnOpen, true);
});

test("explicit pause survives reopening until deliberately resumed", () => {
  const disk = storage(), first = createSectionGuideStore("paused-owner", "market", disk);
  const second = move("market", move("market", null, "start"), "next");
  first.save(move("market", second, "pause"));
  const reopened = createSectionGuideStore("paused-owner", "market", disk);
  reopened.restore();
  const paused = reopened.getSnapshot().progress;
  assert.equal(paused.status, "paused");
  assert.equal(sectionGuideCanOpen(true, true, paused), false);
  const resumed = move("market", paused, "resume");
  assert.equal(resumed.stepId, "sell");
  assert.equal(sectionGuideCanOpen(true, true, resumed), true);
});

test("completed and skipped lessons never auto-open and replay starts at first step", () => {
  for (const section of sectionGuideIds) {
    const complete = finished(section);
    assert.equal(complete.status, "completed");
    for (const progress of [complete, move(section, complete, "skip")]) {
      const disk = storage(), first = createSectionGuideStore(`complete-${section}`, section, disk);
      first.save(progress);
      const reopened = createSectionGuideStore(`complete-${section}`, section, disk);
      reopened.restore();
      assert.equal(sectionGuideCanOpen(true, true, reopened.getSnapshot().progress), false);
      assert.deepEqual(move(section, reopened.getSnapshot().progress, "start"), progress, "ordinary entry must preserve the terminal choice");
      const replay = move(section, progress, "replay");
      assert.equal(replay.stepId, sectionGuideLessons[section][0].id);
      assert.equal(replay.status, "started");
    }
  }
});

test("accounts and sections have independent completion and encoded keys avoid collisions", () => {
  const disk = storage(), first = createSectionGuideStore("player-a", "pantry", disk);
  first.save(finished("pantry"));
  for (const [owner, section] of [["player-b", "pantry"], ["player-a", "market"]]) {
    const next = createSectionGuideStore(owner, section, disk);
    next.restore();
    assert.equal(next.getSnapshot().progress, null);
  }
  assert.notEqual(sectionGuideStorageKey("a:market", "pantry"), sectionGuideStorageKey("a", "market"));
});

test("unavailable or full storage retains current-session choices without throwing", () => {
  const broken = { getItem() { throw new Error("disabled"); }, setItem() { throw new Error("quota"); } };
  const first = createSectionGuideStore("blocked-store-owner", "orders", broken);
  first.restore();
  assert.equal(first.getSnapshot().progress, null);
  const skipped = move("orders", null, "skip");
  first.save(skipped);
  const reopened = createSectionGuideStore("blocked-store-owner", "orders", broken);
  reopened.restore();
  assert.deepEqual(reopened.getSnapshot().progress, skipped);
  assert.equal(sectionGuideCanOpen(true, true, reopened.getSnapshot().progress), false);
});

test("external storage updates can restore a completion without changing other sections", () => {
  const disk = storage(), first = createSectionGuideStore("cross-tab-owner", "builder", disk), second = createSectionGuideStore("cross-tab-owner", "builder", disk);
  first.restore(); second.restore();
  first.save(finished("builder"));
  second.restore();
  assert.equal(second.getSnapshot().progress.status, "completed");
  const other = createSectionGuideStore("cross-tab-owner", "plesk", disk);
  other.restore();
  assert.equal(other.getSnapshot().progress, null);
});

test("malformed values fail safely and copy updates preserve deliberate skips", () => {
  for (const raw of [null, "{", "[]", '"string"', '{"version":2,"status":"started"}', '{"version":1,"status":"unknown"}']) assert.equal(parseSectionGuideProgress(raw, "pantry"), null);
  const skipped = parseSectionGuideProgress('{"version":1,"status":"skipped","stepId":"old-copy-step"}', "pantry");
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.stepId, "items");
  const started = parseSectionGuideProgress('{"version":1,"status":"started","stepId":"unknown"}', "pantry");
  assert.equal(started.stepId, "items");
  assert.equal(move("pantry", started, "back").stepId, "items");
});

test("show navigation is confined to its own open section and detached handlers cannot intercept it", () => {
  const plesk = new EventTarget(), meals = new EventTarget(), visited = [];
  const root = { querySelector(selector) { return selector.includes('"plesk"') ? plesk : selector.includes('"meals"') ? meals : null; } };
  const off = listenForSectionGuideNavigation(plesk, "plesk", stepId => {
    if (!["rods", "bait", "catch"].includes(stepId)) return false;
    visited.push(stepId); return true;
  });
  listenForSectionGuideNavigation(meals, "meals", () => { assert.fail("fishing guidance must not affect another section"); });
  assert.equal(requestSectionGuideNavigation(root, "plesk", "bait"), true);
  assert.deepEqual(visited, ["bait"]);
  assert.equal(requestSectionGuideNavigation(root, "plesk", "purchase"), false, "unknown actions are not handled");
  off();
  assert.equal(requestSectionGuideNavigation(root, "plesk", "rods"), false);
  assert.equal(requestSectionGuideNavigation({ querySelector() { return null; } }, "plesk", "rods"), false);
  assert.deepEqual(visited, ["bait"]);
});

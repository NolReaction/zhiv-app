import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), hooksId = "virtual:dev-bots-ui-hooks";
const cacheDir = await mkdtemp(join(tmpdir(), "zhiv-dev-bots-ui-"));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "dev-bots-ui-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let slots = [], cursor = 0;
      export function reset() { slots = []; cursor = 0; }
      export function render() { cursor = 0; }
      export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
        return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; }
    `; },
    transform(source, id) {
      if (id.endsWith("/features/world/dev/world-dev-bots.tsx"))
        return source.replace('from "react";', `from "${hooksId}";`).replace("function DevBotEditor(", "export function DevBotEditor(");
    },
  }],
});
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const { WorldDevBotsContent, DevBotEditor, devBotTradeHint } = await vite.ssrLoadModule("/features/world/dev/world-dev-bots.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyDevSettlement } = await vite.ssrLoadModule("/features/economy/dev/dev-presets.ts");
const hooks = await vite.ssrLoadModule(hooksId);
const now = "2026-10-19T00:20:00.000Z";
function fixtures() {
  const bot = { id: "01234567-1234-4123-8123-123456789012", publicId: "BOTS-TEST-1234", displayName: "Сосед", circleId: "11234567-1234-4123-8123-123456789012", sharingMode: "LATEST_ONLY", createdAt: now,
    economy: { revision: 0, buildings: economyDevSettlement(2), wallet: { coins: 1000, pearls: 200 }, inventory: { wood: 10 }, jobs: [], storage: { used: 10, capacity: 100, available: 90, reserved: 0, overflow: 0 } },
    equipment: { palette: "moss", head: null, neck: null, rod: null }, listings: [] };
  const buyer = { snapshot: { ownerPublicId: "ME", buildings: economyDevSettlement(2), completedExplorations: economyCatalog.market.requiredExplorations, catalog: economyCatalog } };
  const calls = [], changed = [], visits = [];
  const snapshot = { ownerPublicId: "ME", serverTime: now, maxBots: 5, bots: [bot] };
  const result = { snapshot, botId: bot.id, message: "Сохранено", replayed: false };
  const controller = { snapshot, busy: false, loading: false, uncertain: false, error: null, notice: "",
    async command(action) { calls.push(action); return result; }, async refresh() { calls.push("refresh"); }, async retry() { calls.push("retry"); return result; } };
  const props = { controller, permitted: true, buyer, onBotsChanged: () => changed.push(true), onVisitBot: target => visits.push(target) };
  return { bot, buyer, calls, changed, visits, result, props, controller };
}
function nodes(tree) {
  const result = []; const visit = element => { if (isValidElement(element)) { result.push(element); Children.forEach(element.props.children, visit); } };
  visit(tree); return result;
}
function text(element) { return Children.toArray(element?.props.children).map(child => typeof child === "string" || typeof child === "number" ? child : isValidElement(child) ? text(child) : "").join(""); }
function harness(Component, props) { hooks.reset(); return { render() { hooks.render(); const tree = Component(props); return { tree, nodes: nodes(tree) }; } }; }
const button = (view, label) => view.nodes.find(node => node.type === "button" && text(node) === label);
const control = (view, label) => {
  const parent = view.nodes.find(node => node.type === "label" && text(Children.toArray(node.props.children)[0]) === label);
  assert.ok(parent, `Label ${label} exists`);
  return Children.toArray(parent.props.children).find(node => isValidElement(node) && ["input", "select"].includes(node.type));
};
const formFor = (view, label) => view.nodes.find(node => node.type === "form" && nodes(node).includes(button(view, label)));
const formSubmit = (view, label) => formFor(view, label).props.onSubmit({ preventDefault() {} });
function editor(f = fixtures(), extra = {}) {
  const props = { bot: f.bot, buyer: f.buyer, catalog: economyCatalog, locked: false, async act(action) { f.calls.push(action); }, onVisitBot: f.props.onVisitBot, ...extra };
  return { ...f, props, h: harness(DevBotEditor, props) };
}

test("creating a bot names only the new account and respects maximum, busy and uncertain gates", async () => {
  const f = fixtures(), h = harness(WorldDevBotsContent, f.props);
  assert.deepEqual(f.calls, []);
  control(h.render(), "Имя нового бота").props.onChange({ target: { value: "  Утренний сосед  " } });
  control(h.render(), "Поселение").props.onChange({ target: { value: "3" } });
  formSubmit(h.render(), "Создать бота"); await Promise.resolve();
  assert.deepEqual(f.calls, [{ action: "create", displayName: "Утренний сосед", homeLevel: 3 }]);
  assert.deepEqual(f.changed, [true]);
  for (const block of [() => { f.controller.busy = true; }, () => { f.controller.busy = false; f.controller.uncertain = true; }, () => { f.controller.uncertain = false; f.controller.snapshot.bots = Array(5).fill(f.bot); }]) {
    block(); const view = h.render(); assert.equal(button(view, "Создать бота").props.disabled, true); formSubmit(view, "Создать бота");
  }
  assert.equal(f.calls.length, 1, "blocked callbacks cannot issue account commands programmatically");
});

test("lost responses offer exact-result recovery and refresh the friend list after success", async () => {
  const f = fixtures(); f.controller.uncertain = true;
  const view = harness(WorldDevBotsContent, f.props).render();
  assert.equal(button(view, "Обновить ботов").props.disabled, true);
  assert.equal(button(view, "Проверить результат").props.disabled, false);
  button(view, "Проверить результат").props.onClick(); await Promise.resolve();
  assert.deepEqual(f.calls, ["retry"]); assert.deepEqual(f.changed, [true]);
});

test("a visit uses the selected real friend binding and sharing OFF disables it", () => {
  const e = editor(), view = e.h.render();
  button(view, "В гости").props.onClick();
  assert.deepEqual(e.visits, [{ circleId: e.bot.circleId, targetPublicId: e.bot.publicId, displayName: e.bot.displayName }]);
  assert.deepEqual(e.calls, []);
  e.bot.sharingMode = "OFF"; const hidden = e.h.render(); assert.equal(button(hidden, "В гости").props.disabled, true); button(hidden, "В гости").props.onClick();
  assert.equal(e.visits.length, 1);
});

test("trade guidance opens the existing cheats without upgrading or granting the buyer", () => {
  const f = fixtures(), opened = []; f.buyer.snapshot.buildings = economyDevSettlement(1);
  const e = editor(f, { onOpenCheats: () => opened.push(true) }), view = e.h.render();
  assert.match(devBotTradeHint(f.bot, f.buyer), /ваш дом уровня 2/);
  button(view, "Открыть мои читы").props.onClick(); assert.deepEqual(opened, [true]); assert.deepEqual(e.calls, []);
  assert.equal(f.buyer.snapshot.buildings.home, 1);
  f.buyer.snapshot.buildings = economyDevSettlement(4); assert.match(devBotTradeHint(f.bot, f.buyer), /2–3 или 4–5/);
});

test("outfit controls save actual compatible slots including the legacy visible rod", () => {
  const e = editor(); let view = e.h.render();
  control(view, "Часть образа").props.onChange({ target: { value: "rod" } }); view = e.h.render();
  const options = Children.toArray(control(view, "Вещь персонажа").props.children).flat();
  assert.ok(options.some(option => option?.props?.value === "willow_rod"));
  assert.ok(!options.some(option => option?.props?.value === "reed_rod"));
  control(view, "Вещь персонажа").props.onChange({ target: { value: "willow_rod" } }); formSubmit(e.h.render(), "Сохранить одежду");
  assert.deepEqual(e.calls, [{ action: "equip", botId: e.bot.id, slot: "rod", itemId: "willow_rod" }]);
});

test("currency inputs use displayed pearls and the existing stored-unit grant quanta", () => {
  const e = editor(); control(e.h.render(), "Валюта бота").props.onChange({ target: { value: "pearls" } });
  let view = e.h.render(); assert.equal(control(view, "Выдать валюту").props.step, 25);
  control(view, "Выдать валюту").props.onChange({ target: { value: "100" } }); formSubmit(e.h.render(), "Выдать валюту боту");
  assert.deepEqual(e.calls, [{ action: "grant_currency", botId: e.bot.id, currency: "pearls", quantity: 200 }]);
  control(e.h.render(), "Выдать валюту").props.onChange({ target: { value: "3" } }); view = e.h.render();
  assert.equal(button(view, "Выдать валюту боту").props.disabled, true); formSubmit(view, "Выдать валюту боту"); assert.equal(e.calls.length, 1);
});

test("a storefront lot takes real bot stock, exact whole-lot price, and can grant only the missing stock", () => {
  const e = editor(); let view = e.h.render();
  assert.equal(button(view, "Выставить лот").props.disabled, false); formSubmit(view, "Выставить лот");
  assert.deepEqual(e.calls, [{ action: "create_listing", botId: e.bot.id, itemId: "wood", quantity: 5, totalPrice: 150 }]);
  e.bot.economy.inventory.wood = 2; view = e.h.render(); assert.equal(button(view, "Выставить лот").props.disabled, true); formSubmit(view, "Выставить лот");
  assert.equal(e.calls.length, 1);
  button(view, "Выдать недостающее для партии").props.onClick();
  assert.deepEqual(e.calls.at(-1), { action: "grant_item", botId: e.bot.id, itemId: "wood", quantity: 3 });
  assert.equal(e.buyer.snapshot.buildings.home, 2, "seller preparation cannot change the buyer");
});

test("only real active lots have seller-scoped cancellation", () => {
  const e = editor(); e.bot.listings = [{ id: "LOT1", itemId: "wood", quantity: 3, totalPrice: 30, status: "active" }, { id: "LOT2", itemId: "stone", quantity: 2, totalPrice: 60, status: "sold" }];
  const view = e.h.render(), buttons = view.nodes.filter(node => node.props["aria-label"]?.startsWith("Снять лот:"));
  assert.equal(buttons.length, 1); buttons[0].props.onClick(); assert.deepEqual(e.calls, [{ action: "cancel_listing", botId: e.bot.id, listingId: "LOT1" }]);
});

test("all destructive changes need a second explicit click and lock guards also protect callbacks", () => {
  const e = editor(); let view = e.h.render();
  assert.ok(!button(view, "Да, удалить бота")); button(view, "Удалить бота").props.onClick();
  assert.deepEqual(e.calls, []); view = e.h.render(); button(view, "Оставить бота").props.onClick();
  assert.ok(!button(e.h.render(), "Да, удалить бота")); button(e.h.render(), "Удалить бота").props.onClick();
  e.props.locked = true; view = e.h.render(); assert.equal(button(view, "Да, удалить бота").props.disabled, true); button(view, "Да, удалить бота").props.onClick(); assert.deepEqual(e.calls, []);
  e.props.locked = false; button(e.h.render(), "Да, удалить бота").props.onClick(); assert.deepEqual(e.calls, [{ action: "delete", botId: e.bot.id }]);
});

test("the job controls preserve ordinary target ids and separate time completion from claim", () => {
  const e = editor(); let view = e.h.render();
  control(view, "Занятие бота").props.onChange({ target: { value: "production" } });
  control(e.h.render(), "Задание для бота").props.onChange({ target: { value: economyCatalog.recipes[0].id } }); formSubmit(e.h.render(), "Запустить задание бота");
  assert.deepEqual(e.calls, [{ action: "start_job", botId: e.bot.id, kind: "production", targetId: economyCatalog.recipes[0].id }]);
  e.bot.economy.jobs = [{ id: "JOB", kind: "production", targetId: "garden", recipeId: economyCatalog.recipes[0].id }]; view = e.h.render();
  button(view, "Убрать ожидание бота").props.onClick(); button(view, "Забрать результат").props.onClick();
  assert.deepEqual(e.calls.slice(1), [{ action: "finish_jobs", botId: e.bot.id }, { action: "claim_job", botId: e.bot.id, jobId: "JOB" }]);
  e.bot.economy.jobs[0].collection = { startedAt: null, finishesAt: null, seconds: 8, kind: "berry_harvest" };
  view = e.h.render(); assert.ok(!button(view, "Забрать результат")); button(view, "Отправить на сбор").props.onClick();
  assert.deepEqual(e.calls.at(-1), { action: "claim_job", botId: e.bot.id, jobId: "JOB" });
});

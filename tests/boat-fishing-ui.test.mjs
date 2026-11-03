import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ configFile: false, appType: "custom", root, cacheDir: `/tmp/boat-ui-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyShipSchema } = await vite.ssrLoadModule("/features/economy/domain/ship-model.ts");
const { newEconomyState, economyStorage, applyEconomyCommand } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { publicBoatState } = await vite.ssrLoadModule("/features/economy/domain/boat-fishing.ts");
const { initialBoatReel, stepBoatReel, replayBoatReel } = await vite.ssrLoadModule("/features/economy/domain/boat-reel.ts");
const checkpoint = await vite.ssrLoadModule("/features/economy/ui/boat/boat-reel-checkpoint.ts");
const { WorldBoatFishingDialog } = await vite.ssrLoadModule("/features/economy/ui/boat/world-boat-fishing-dialog.tsx");
const { WorldExpeditionsMenu } = await vite.ssrLoadModule("/features/economy/ui/expeditions/world-expeditions-menu.tsx");
const { BoatRecords, BoatCatchList } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-panels.tsx");
const at = Date.parse("2026-11-03T10:00:00Z");
const uuid = () => crypto.randomUUID();
function state() {
  const value = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 3, workshopLevel: 3 });
  value.wallet.coins = 100000; value.inventory = { planks: 12, rope: 12, hardwood: 3 }; value.buildings.warehouse = 3;
  return value;
}
function view(value) { return { ...value, ownerPublicId: "0000-0000-0000", revision: 2, serverTime: new Date(at).toISOString(), catalog: economyCatalog,
  boat: publicBoatState(value.boat), ship: economyShipSchema.parse(value.ship), storage: economyStorage(value) }; }
function run(value, action, targetId, now = at) { return applyEconomyCommand(value, { action, targetId, requestId: uuid(), ownerPublicId: "0000-0000-0000", expectedRevision: 2, quantity: 1, totalPrice: 0 }, now, uuid, {}, () => 37); }
function render(value, now = at) { return renderToStaticMarkup(createElement(WorldBoatFishingDialog, { economy: { snapshot: view(value), now, busy: false, uncertain: false, retryAt: 0, snapshotConfirmed: true,
  act() { assert.fail("Opening boat UI must never mutate an expedition"); } }, onClose() {} })); }
function challenge() { return { id: uuid(), rulesVersion: 1, seed: 17, tickMs: 50, maxTicks: 600, zoneWidth: 3200, difficulty: 1, startedAt: new Date(at).toISOString(), expiresAt: new Date(at + 120000).toISOString() }; }
const memory = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };

test("opening a broken or docked boat is read-only and explains capped outings", () => {
  const value = state(), before = structuredClone(value), broken = render(value);
  assert.match(broken, /data-boat-phase="broken"/); assert.match(broken, /Восстановить лодку/);
  assert.match(broken, /рыбалка на пирсе остаётся/); assert.deepEqual(value, before);
  value.boat.level = 1;
  assert.match(render(value), /4 заброса/); assert.match(render(value), /Отправиться на рыбалку/);
  value.boat.upgrades.push("crate"); assert.match(render(value), /5 забросов/);
});

test("a cached catalog without boats hides its entry and an already-open dialog remains read-only and recoverable", () => {
  const legacy = view(state()); legacy.catalog = structuredClone(economyCatalog); delete legacy.catalog.boat;
  const before = structuredClone(legacy), economy = { snapshot: legacy, now: at, busy: false, uncertain: false, retryAt: 0, snapshotConfirmed: true,
    act() { assert.fail("Missing boat data must not start an action"); }, refresh() { assert.fail("Opening the fallback must not request data automatically"); } };
  const fallback = renderToStaticMarkup(createElement(WorldBoatFishingDialog, { economy, onClose() {} }));
  assert.match(fallback, /data-boat-unavailable/); assert.match(fallback, /Данные о лодке пока недоступны/); assert.match(fallback, />Обновить</);
  assert.doesNotMatch(fallback, /data-boat-upgrade|Отправиться на рыбалку|Восстановить лодку/);
  const entry = snapshot => renderToStaticMarkup(createElement(WorldExpeditionsMenu, { economy: { ...economy, snapshot }, initialSector: "shore", onOpenBoat() { assert.fail("Entry rendering must not navigate"); }, onOpenPantry() {} }));
  assert.doesNotMatch(entry(legacy), /Лодочная рыбалка/);
  assert.match(entry(view(state())), /Лодочная рыбалка/);
  assert.deepEqual(legacy, before);
});

test("outbound, fishing, automatic return and arrival have distinct controls without starting casts", () => {
  const value = state(); value.boat.level = 1; run(value, "depart_boat", "river_reach");
  const voyage = value.boat.voyage, arrival = Date.parse(voyage.arrivesAt);
  const outward = render(value);
  assert.match(outward, /data-boat-phase="outbound"/); assert.doesNotMatch(outward, /Забросить удочку/);
  const arrived = render(value, arrival);
  assert.match(arrived, /data-boat-phase="fishing"/); assert.match(arrived, /Забросить удочку/); assert.match(arrived, /До возвращения/);
  assert.match(arrived, /data-boat-map-view="true"/); assert.match(arrived, /data-fishing-scene="waiting"/);
  assert.doesNotMatch(arrived, /role="tab"|data-boat-module=/);
  const returning = render(value, Date.parse(voyage.fishingUntil));
  assert.match(returning, /data-boat-phase="returning"/); assert.doesNotMatch(returning, /Забросить удочку/);
  const ready = render(value, Date.parse(voyage.fishingUntil) + voyage.inboundSeconds * 1000);
  assert.match(ready, /data-boat-phase="ready"/); assert.match(ready, /Завершить выход/);
});

test("live and expired challenges preserve their identity and do not expose a predetermined fish", () => {
  const value = state(); value.boat.level = 1; run(value, "depart_boat", "river_reach");
  const voyage = value.boat.voyage, arrival = Date.parse(voyage.arrivesAt); run(value, "begin_boat_cast", voyage.id, arrival);
  const before = structuredClone(value), live = render(value, arrival);
  assert.match(live, new RegExp(`data-boat-reel="${value.boat.voyage.challenge.id}"`));
  assert.match(live, /Забрасываем удочку/); assert.doesNotMatch(live, /Подсечь|Начать вываживание/); assert.doesNotMatch(live, /Забросить удочку|weightGrams|challengeSeed|slots/);
  const expired = render(value, arrival + 120000);
  assert.match(expired, /data-reel-status="expired"/); assert.match(expired, /Забросить удочку/);
  assert.deepEqual(value, before);
});

test("boat menus show only physical upgrades and preserve legacy fragments and permanent items without exposing a blueprint workshop", () => {
  const value = state(); value.boat.level = 1;
  value.boat.blueprints = { landing_net: 3, telescope: 2 }; value.boat.artifacts = ["landing_net"];
  const before = structuredClone(value), html = render(value);
  assert.equal([...html.matchAll(/role="tab"/g)].length, 3);
  assert.doesNotMatch(html, /Чертежи|Фрагменты схемы|Изготовить|data-boat-module="(?:landing_net|telescope)"/);
  assert.match(html, /data-boat-module="repair"/); assert.match(html, /data-boat-module="oars"/); assert.match(html, /data-boat-module="crate"/);
  assert.deepEqual(value, before);
});

test("a caught fish remains onboard until delivery; personal records do not depend on stock", () => {
  const value = state(); value.boat.level = 1; run(value, "depart_boat", "river_reach");
  value.boat.voyage.catches = [{ castIndex: 0, fishId: "fish_silverfin", weightGrams: 1234, caughtAt: new Date(at).toISOString() }];
  const html = renderToStaticMarkup(createElement(BoatCatchList, { state: view(value), boat: publicBoatState(value.boat) }));
  assert.match(html, /1,234 кг/); assert.match(html, /после возвращения и разгрузки/);
  value.boat.records.fish_silverfin = { weightGrams: 1234, caughtAt: new Date(at).toISOString() };
  value.inventory = {};
  const records = renderToStaticMarkup(createElement(BoatRecords, { state: view(value), boat: publicBoatState(value.boat) }));
  assert.match(records, /data-boat-record="fish_silverfin"/); assert.match(records, /1,234 кг/);
});

test("saved control checkpoints replay the same result and are isolated by owner, voyage and challenge", () => {
  const attempt = challenge(), saved = memory(), inputs = [{ tick: 0, held: true }, { tick: 8, held: false }];
  const reel = replayBoatReel(attempt, inputs, 20), key = checkpoint.boatReelCheckpointKey("owner", "voyage", attempt.id);
  checkpoint.writeBoatReelCheckpoint(saved, key, attempt, reel, inputs);
  assert.deepEqual(checkpoint.readBoatReelCheckpoint(saved, key, attempt), { reel, inputs });
  assert.equal(checkpoint.readBoatReelCheckpoint(saved, checkpoint.boatReelCheckpointKey("other", "voyage", attempt.id), attempt).reel.tick, 0);
  assert.equal(checkpoint.readBoatReelCheckpoint(saved, key, { ...attempt, seed: 99 }).reel.tick, 0);
  assert.equal(checkpoint.readBoatReelCheckpoint(saved, key, { ...attempt, id: uuid() }).reel.tick, 0);
});

test("broken or unavailable browser storage cannot award fish or stop a fresh attempt", () => {
  const attempt = challenge(), saved = memory(); saved.setItem("test", JSON.stringify({ challengeId: attempt.id, seed: attempt.seed, startedAt: attempt.startedAt, endTick: 2, inputs: [{ tick: 9, held: true }] }));
  assert.equal(checkpoint.readBoatReelCheckpoint(saved, "test", attempt).reel.tick, 0);
  saved.setItem("test", "null"); assert.equal(checkpoint.readBoatReelCheckpoint(saved, "test", attempt).reel.tick, 0);
  const denied = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.equal(checkpoint.readBoatReelCheckpoint(denied, "test", attempt).reel.tick, 0);
  assert.doesNotThrow(() => checkpoint.writeBoatReelCheckpoint(denied, "test", attempt, stepBoatReel(attempt, initialBoatReel(attempt), false), []));
});

test("starting a different attempt removes only the same owner's previous fishing checkpoint", () => {
  const saved = memory(), first = checkpoint.boatReelCheckpointKey("owner", "voyage", "first"), second = checkpoint.boatReelCheckpointKey("owner", "voyage", "second");
  const other = checkpoint.boatReelCheckpointKey("other", "voyage", "first");
  saved.setItem(first, "first"); saved.setItem(other, "other");
  checkpoint.retainBoatReelCheckpoint(saved, "owner", first); checkpoint.retainBoatReelCheckpoint(saved, "owner", second);
  assert.equal(saved.getItem(first), null); assert.equal(saved.getItem(other), "other");
  saved.setItem("zhiv.boat-reel.current.owner", "unrelated"); saved.setItem("unrelated", "keep");
  checkpoint.retainBoatReelCheckpoint(saved, "owner", second); assert.equal(saved.getItem("unrelated"), "keep");
});

test("same-tick input events collapse to one legal state and a pause does not add an unsimulated input to submission", () => {
  const inputs = []; checkpoint.changeBoatReelInput(inputs, 0, true); checkpoint.changeBoatReelInput(inputs, 0, false); assert.deepEqual(inputs, []);
  checkpoint.changeBoatReelInput(inputs, 2, true); checkpoint.changeBoatReelInput(inputs, 3, true); assert.deepEqual(inputs, [{ tick: 2, held: true }]);
  checkpoint.changeBoatReelInput(inputs, 8, false);
  const attempt = challenge(), reel = replayBoatReel(attempt, inputs.filter(input => input.tick < 8), 8);
  const submission = checkpoint.boatReelSubmission(attempt, reel, inputs);
  assert.deepEqual(submission.inputs, [{ tick: 2, held: true }]); assert.equal(submission.endTick, 8);
  assert.deepEqual(replayBoatReel(attempt, submission.inputs, submission.endTick), reel);
  assert.deepEqual(Object.keys(submission).sort(), ["challengeId", "endTick", "inputs"]);
});


test("directional feedback agrees with replay progress at both zone edges", async () => {
  const { boatReelFeedback } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-reel-feedback.ts");
  const attempt = challenge();
  let current = initialBoatReel(attempt);
  for (let tick = 0; tick < 90 && current.status === "active"; tick++) {
    const next = stepBoatReel(attempt, current, tick % 40 < 20);
    const feedback = boatReelFeedback(next, attempt.zoneWidth);
    assert.equal(feedback.inZone, next.progress > current.progress);
    if (!feedback.inZone) assert.equal(feedback.direction, next.fish > next.bar ? "lift" : "ease");
    current = next;
  }
  const center = { bar: 5000, fish: 5000, progress: 1000 };
  assert.equal(boatReelFeedback(center, 2000).urgent, false);
  assert.equal(boatReelFeedback({ ...center, fish: 6000 }, 2000).inZone, true);
  assert.equal(boatReelFeedback({ ...center, fish: 6001 }, 2000).urgent, true);
  assert.equal(boatReelFeedback({ ...center, fish: 3999 }, 2000).direction, "ease");
});

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { z } from "zod";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { newEconomyState } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { mailMessageSchema } = await vite.ssrLoadModule("/features/mailbox/model.ts");
const { worldCommandSchema } = await vite.ssrLoadModule("/features/world/domain/model.ts");

test("legacy defaults create independent nested state for each player and each read", () => {
  const first = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  const second = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  first.tradeRelations.reputation.builder = 4200;
  first.tradeRelations.dailyOrderXp.builder = 60;
  first.fishing.ownedRods.push("river_rod");
  first.progression.routes.forest = 100;
  first.stageOrders.stages["2"] = { step: 1, completed: false, terms: null, availableAt: null, intervalSeconds: null, completionRewards: null };
  assert.deepEqual(second.tradeRelations.reputation, {});
  assert.deepEqual(second.tradeRelations.dailyOrderXp, {});
  assert.deepEqual(second.fishing.ownedRods, ["reed_rod"]);
  assert.deepEqual(second.progression.routes, {});
  assert.deepEqual(second.stageOrders.stages, {});
  assert.deepEqual(model.economyTradeRelationsSchema.parse(undefined).reputation, {});
  assert.deepEqual(model.economyTradeRelationsSchema.parse({ reputation: { builder: 10 } }).reputation, { builder: 10 });
});

test("sparse resident maps retain old records and reject unknown residents", () => {
  for (const key of ["reputation", "dailyOrderXp", "dailyPurchaseXp"]) {
    assert.deepEqual(model.economyTradeRelationsSchema.parse({ [key]: {} })[key], {});
    assert.deepEqual(model.economyTradeRelationsSchema.parse({ [key]: { plesk: 1 } })[key], { plesk: 1 });
    assert.equal(model.economyTradeRelationsSchema.safeParse({ [key]: { impostor: 1 } }).success, false);
    assert.equal(model.economyTradeRelationsSchema.safeParse({ [key]: { plesk: -1 } }).success, false);
  }
});

test("persisted GUID identifiers retain the earlier contract while v4 commands stay strict", () => {
  const legacyGuid = "11111111-1111-1111-1111-111111111111";
  const message = { id: legacyGuid, type: "event", title: "Письмо", body: "Сохранённое письмо",
    createdAt: "2026-10-26T10:00:00.000Z", readAt: null, notify: true, attachments: null };
  assert.equal(mailMessageSchema.parse(message).id, legacyGuid);
  assert.equal(mailMessageSchema.safeParse({ ...message, id: "not-an-id" }).success, false);
  const command = { requestId: legacyGuid, ownerPublicId: "0000-0000-0001", expectedRevision: 0, action: "claim_journey" };
  assert.equal(worldCommandSchema.safeParse(command).success, false);
  const accepted = worldCommandSchema.parse({ ...command, requestId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(accepted.target, "");
  assert.equal(worldCommandSchema.safeParse({ ...accepted, unexpected: true }).success, false);
});

test("bounded arrays reject oversized hostile input before validating every child", () => {
  let checked = 0;
  const limited = z.array(z.string().superRefine(() => { checked++; })).max(3);
  const result = limited.safeParse(Array(10_000).fill("a"));
  assert.equal(result.success, false);
  assert.equal(checked, 0, "patched runtime must not traverse an already oversized collection");
  assert.equal(result.error.issues.length, 1);
});

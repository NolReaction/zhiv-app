import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
after(() => vite.close());
const identity = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const game = await vite.ssrLoadModule("/lib/dev/game-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const records = await vite.ssrLoadModule("/lib/dev/fishing-records-store.ts");
const { FishingRecordLeaders } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-records.tsx");
const { getFishingRecords } = await vite.ssrLoadModule("/features/economy/sync/api.ts");
beforeEach(() => { identity.resetDevStoreForTests(); game.resetDevGameStoreForTests(); });

const ok = result => { assert.equal(result.kind, "ok"); return result.value; };
const player = name => identity.createDevIdentity(name, crypto.randomUUID());
const share = (user, enabled, version) => records.updateDevFishingVisibility(user.token, {
  ownerPublicId: user.me.user.publicId, expectedVersion: version, leaderboardOptIn: enabled,
});
const fishId = "fish_silverfin";
function delivered(user, grams) {
  // Seed an existing authoritative save, then publish precisely the confirmed projection a successful claim returns.
  const owner = user.me.user.publicId;
  economy.getDevEconomy(user.token);
  const state = globalThis.__zhivDevEconomyStore.profiles.get(owner).state;
  state.boat.records[fishId] = { weightGrams: grams, caughtAt: new Date().toISOString() };
  const view = economy.getDevEconomy(user.token);
  records.publishDevFishingRecords(view);
  return view;
}

test("fishing publication is a separate opt-in, backfills confirmed catches, resolves ties and rechecks friendships", () => {
  const me = player("Мохлик"), friend = player("Дима"), stranger = player("Плёска");
  const request = ok(identity.sendDevDirectRequest(me.token, friend.me.user.publicId, crypto.randomUUID()));
  const relation = ok(identity.actOnDevDirectRequest(friend.token, request.request.requestId, "ACCEPTED")).person;
  delivered(me, 420); delivered(friend, 420); delivered(stranger, 730);
  ok(game.updateDevGameVisibility(me.token, me.me.user.publicId, true, 0));
  const board = scope => ok(records.getDevFishingRecords(me.token, scope));
  assert.deepEqual(board("global").entries, []);
  for (const p of [me, friend, stranger]) ok(share(p, true, 0));
  assert.deepEqual(board("global").entries, [{ fishId, weightGrams: 730, displayName: "Плёска", tiedCount: 1, isMe: false }]);
  assert.deepEqual(board("friends").entries, [{ fishId, weightGrams: 420, displayName: "Мохлик", tiedCount: 2, isMe: true }]);
  delivered(friend, 600);
  assert.equal(board("friends").entries[0].displayName, "Дима");
  assert.equal(ok(share(friend, false, 1)).visibilityVersion, 2);
  assert.equal(ok(share(friend, false, 1)).visibilityVersion, 2);
  assert.equal(share(friend, true, 0).code, "GAME_VISIBILITY_CONFLICT");
  delivered(friend, 800);
  assert.equal(board("friends").entries[0].displayName, "Мохлик");
  assert.equal(board("global").entries[0].weightGrams, 730);
  ok(share(friend, true, 2));
  assert.equal(board("friends").entries[0].weightGrams, 800);
  ok(identity.removeDevPerson(me.token, relation.circleId));
  assert.equal(board("friends").entries[0].displayName, "Мохлик");
  assert.equal(board("global").entries[0].displayName, "Дима");
  assert.equal(records.getDevFishingRecords(undefined, "global").code, "UNAUTHORIZED");
  assert.equal(records.updateDevFishingVisibility(me.token, { ownerPublicId: friend.me.user.publicId, leaderboardOptIn: true, expectedVersion: 2 }).code, "GAME_OWNER_CHANGED");
});

test("published records hide undiscovered artwork and label a shared first place for the viewer", () => {
  const me = player("Мохлик"), friend = player("Дима");
  delivered(friend, 550); ok(share(friend, true, 0));
  const render = state => renderToStaticMarkup(createElement(FishingRecordLeaders, { state, board: ok(records.getDevFishingRecords(me.token, "global")) }));
  const hidden = render(economy.getDevEconomy(me.token));
  assert.match(hidden, /Неизвестная рыба/); assert.doesNotMatch(hidden, /Серебринка|fish_silverfin|Ваш рекорд/);
  const state = delivered(me, 550); ok(share(me, true, 0));
  const tied = render(state);
  assert.match(tied, /Серебринка/); assert.match(tied, /Ваш рекорд/); assert.match(tied, /Делят рекорд: 2/);
});

test("the records client rejects a response for another account or audience", async t => {
  const me = "0000-0000-0000";
  const reply = { ownerPublicId: me, scope: "friends", leaderboardOptIn: true, visibilityVersion: 1, entries: [] };
  let result = reply;
  t.mock.method(globalThis, "fetch", async () => Response.json(result));
  assert.deepEqual(await getFishingRecords(me, "friends"), reply);
  result = { ...reply, scope: "global" };
  await assert.rejects(getFishingRecords(me, "friends"), /Рейтинг изменился/);
  result = { ...reply, ownerPublicId: "0000-0000-0001" };
  await assert.rejects(getFishingRecords(me, "friends"), /Рейтинг изменился/);
});

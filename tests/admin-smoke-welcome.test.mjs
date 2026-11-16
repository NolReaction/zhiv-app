import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../scripts/smoke-admin.mjs", import.meta.url), "utf8");
const start = source.indexOf("const welcomeInbox = await fixtureInbox();");
const end = source.indexOf('await api("GET", mailboxPath, { expected: 401 });', start);
assert.ok(start >= 0 && end > start, "The isolated production welcome smoke must remain executable");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const smokeWelcome = new AsyncFunction("assert", "fixtureInbox", "api", "mailTarget", "initialMailEconomy", source.slice(start, end));

function fixture({ copies = 1, mintOnRead = false, claimedAt = null, pearls = 20 } = {}) {
  const letter = { id: "welcome-id", type: "event", notify: false, attachments: null,
    gift: { pearls, claimedAt }, readAt: null };
  const initial = { wallet: { coins: 150, pearls: 0 }, revision: 1 };
  const state = structuredClone(initial), calls = [];
  const inbox = async () => ({ messages: Array.from({ length: copies }, () => structuredClone(letter)),
    unreadCount: letter.readAt ? 0 : copies });
  const api = async (method, path, options) => {
    calls.push({ method, path });
    if (method === "POST" && path === "/api/v1/mail/welcome-id/read") {
      assert.equal(options.cookie, "fixture-cookie");
      assert.deepEqual(options.body, { expectedOwnerPublicId: "fixture-owner" });
      letter.readAt = "2026-10-20T12:00:00Z";
      if (mintOnRead) { state.wallet.pearls += pearls * 2; state.revision++; }
      return { data: { unreadCount: 0, readAt: letter.readAt } };
    }
    assert.equal(method, "GET");
    assert.equal(path, "/api/v1/economy");
    return { data: structuredClone(state) };
  };
  return { run: () => smokeWelcome(assert, inbox, api, { cookie: "fixture-cookie", publicId: "fixture-owner" }, initial), calls };
}

test("production admin smoke accepts one unclaimed welcome and explicitly reads it without collecting", async () => {
  const scenario = fixture();
  await scenario.run();
  assert.deepEqual(scenario.calls, [{ method: "POST", path: "/api/v1/mail/welcome-id/read" },
    { method: "GET", path: "/api/v1/economy" }]);
});

test("production admin smoke rejects welcome duplication and implicit gift payment", async () => {
  for (const options of [{ copies: 0 }, { copies: 2 }, { mintOnRead: true }, { pearls: 100 }, { claimedAt: "2026-10-20T11:00:00Z" }]) {
    await assert.rejects(fixture(options).run(), { name: "AssertionError" });
  }
});

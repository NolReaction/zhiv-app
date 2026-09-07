import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
});

const store = await vite.ssrLoadModule("/lib/dev-api-store.ts");

after(async () => {
  await vite.close();
});

function ok(result) {
  assert.equal(result.kind, "ok");
  return result.value;
}

function capabilityToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Buffer.from(bytes).toString("base64url");
  assert.equal(token.length, 43);
  return token;
}

test("direct invite preview and redeem share exact expiry and idempotency errors", async () => {
  store.resetDevStoreForTests();
  const inviter = store.createDevIdentity("Приглашающий", crypto.randomUUID());
  const recipient = store.createDevIdentity("Получатель", crypto.randomUUID());
  const startedAt = new Date("2026-08-30T10:00:00.000Z");
  const expiredToken = capabilityToken();
  ok(
    store.createDevDirectInviteLink(
      inviter.token,
      expiredToken,
      crypto.randomUUID(),
      startedAt,
    ),
  );
  const expiryBoundary = new Date(startedAt.getTime() + 7 * 24 * 60 * 60_000);
  assert.equal(store.previewDevDirectInvite(expiredToken, expiryBoundary).kind, "expired");
  assert.equal(
    store.redeemDevDirectInvite(
      recipient.token,
      expiredToken,
      crypto.randomUUID(),
      expiryBoundary,
    ).kind,
    "expired",
  );

  const firstInviter = store.createDevIdentity("Первый", crypto.randomUUID());
  const secondInviter = store.createDevIdentity("Второй", crypto.randomUUID());
  const firstToken = capabilityToken();
  const secondToken = capabilityToken();
  ok(store.createDevDirectInviteLink(firstInviter.token, firstToken, crypto.randomUUID()));
  ok(store.createDevDirectInviteLink(secondInviter.token, secondToken, crypto.randomUUID()));
  const redeemKey = crypto.randomUUID();
  const accepted = ok(
    store.redeemDevDirectInvite(recipient.token, firstToken, redeemKey),
  );
  const replay = ok(
    store.redeemDevDirectInvite(recipient.token, firstToken, redeemKey),
  );
  assert.equal(accepted.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(
    store.redeemDevDirectInvite(recipient.token, firstToken, crypto.randomUUID()).kind,
    "conflict",
  );
  assert.equal(
    store.redeemDevDirectInvite(recipient.token, secondToken, redeemKey).kind,
    "conflict",
  );

  const inviteErrors = await vite.ssrLoadModule(
    "/app/api/v1/direct-invite-links/_shared.ts",
  );
  for (const routeName of ["preview", "redeem"]) {
    const response = inviteErrors.directInviteResultError({ kind: "expired" });
    assert.equal(response.status, 410, routeName);
    assert.deepEqual(await response.json(), {
      code: "INVITE_EXPIRED",
      message: "Ссылка уже недействительна",
    });
  }
});

test("one invite admits multiple people, preserves privacy and cannot recreate a removed link", context => {
  store.resetDevStoreForTests();
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-07T10:00:00Z") });
  const inviter = store.createDevIdentity("Owner", crypto.randomUUID());
  const first = store.createDevIdentity("First", crypto.randomUUID());
  const second = store.createDevIdentity("Second", crypto.randomUUID());
  store.createDevCheckIn(inviter.token, crypto.randomUUID());
  context.mock.timers.tick(31_000);
  const token = capabilityToken(), firstKey = crypto.randomUUID();
  ok(store.createDevDirectInviteLink(inviter.token, token, crypto.randomUUID()));
  const accepted = ok(store.redeemDevDirectInvite(first.token, token, firstKey));
  assert.equal(accepted.person.lastCheckInAt, null);
  ok(store.previewDevDirectInvite(token));
  const secondKey = crypto.randomUUID();
  const another = ok(store.redeemDevDirectInvite(second.token, token, secondKey));
  assert.equal(another.person.lastCheckInAt, null);
  assert.notEqual(accepted.person.circleId, another.person.circleId);
  assert.equal(ok(store.redeemDevDirectInvite(first.token, token, firstKey)).replayed, true);
  ok(store.removeDevPerson(inviter.token, accepted.person.circleId));
  assert.equal(store.redeemDevDirectInvite(first.token, token, firstKey).kind, "conflict");
  assert.equal(store.redeemDevDirectInvite(first.token, token, crypto.randomUUID()).kind, "conflict");
  assert.equal(ok(store.redeemDevDirectInvite(second.token, token, secondKey)).replayed, true);
});

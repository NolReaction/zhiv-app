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

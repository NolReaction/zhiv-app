import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
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

function connect(first, second) {
  const sent = ok(
    store.sendDevDirectRequest(first.token, second.me.user.publicId, crypto.randomUUID()),
  );
  const accepted = ok(
    store.actOnDevDirectRequest(second.token, sent.request.requestId, "ACCEPTED"),
  );
  assert.ok(accepted.person);
  return accepted.person;
}

function trust(owner, trustee) {
  const person = connect(owner, trustee);
  const contacts = ok(
    store.addDevRecoveryContact(owner.token, person.circleId, crypto.randomUUID()),
  );
  const contact = contacts.contacts.find(
    (candidate) => candidate.user.publicId === trustee.me.user.publicId,
  );
  assert.ok(contact);
  return contact;
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stopChild(child) {
  const kill = (signal) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // The complete process group has already exited.
    }
  };
  kill("SIGTERM");
  if (child.exitCode === null) {
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  if (child.exitCode === null) {
    kill("SIGKILL");
    await once(child, "exit");
  }
}

function responseSetCookies(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  const combined = response.headers.get("set-cookie");
  return combined ? [combined] : [];
}

function cookiePair(setCookie) {
  return setCookie.split(";", 1)[0];
}

test("a claimant-bound recovery requires the selected trusted friend", () => {
  store.resetDevStoreForTests();
  const targetBootstrapKey = crypto.randomUUID();
  const target = store.createDevIdentity("Целевой профиль", targetBootstrapKey);
  const targetSecondSession = store.createDevIdentity("Целевой профиль", targetBootstrapKey);
  const friend = store.createDevIdentity("Доверенный друг", crypto.randomUUID());
  const contact = trust(target, friend);
  const startedAt = new Date("2026-08-30T12:00:00.000Z");
  const approvalToken = capabilityToken();

  const created = ok(
    store.createDevRecoveryAttempt(
      approvalToken,
      crypto.randomUUID(),
      undefined,
      startedAt,
    ),
  );
  assert.deepEqual(
    {
      status: created.attempt.status,
      target: created.attempt.target,
      replayed: created.attempt.replayed,
      expiresAt: created.attempt.expiresAt,
    },
    {
      status: "PENDING",
      target: null,
      replayed: false,
      expiresAt: "2026-08-30T12:10:00.000Z",
    },
  );

  const preview = ok(
    store.previewDevRecoveryApproval(friend.token, approvalToken, startedAt),
  );
  assert.deepEqual(preview.eligible, [{ contactId: contact.contactId, target: target.me.user }]);

  const approved = ok(
    store.confirmDevRecoveryApproval(
      friend.token,
      approvalToken,
      contact.contactId,
      crypto.randomUUID(),
      new Date(startedAt.getTime() + 1_000),
    ),
  );
  assert.equal(approved.status, "APPROVED");
  assert.deepEqual(approved.target, target.me.user);
  assert.equal(
    ok(
      store.getDevRecoveryAttempt(
        created.claimToken,
        new Date(startedAt.getTime() + 1_000),
      ),
    ).status,
    "APPROVED",
  );

  const completed = ok(
    store.completeDevRecoveryAttempt(
      created.claimToken,
      crypto.randomUUID(),
      new Date(startedAt.getTime() + 2_000),
    ),
  );
  assert.equal(completed.attempt.status, "COMPLETED");
  assert.deepEqual(completed.attempt.target, target.me.user);
  assert.deepEqual(completed.me.user, target.me.user);
  assert.equal(store.getDevIdentity(target.token), null, "the old target session must be revoked");
  assert.equal(
    store.getDevIdentity(targetSecondSession.token),
    null,
    "every old target session must be revoked",
  );
  assert.deepEqual(store.getDevIdentity(completed.sessionToken)?.user, target.me.user);
  assert.deepEqual(store.getDevIdentity(friend.token)?.user, friend.me.user);
});

test("completion removes untrusted recovery footholds but keeps the approving friend", () => {
  store.resetDevStoreForTests();
  const target = store.createDevIdentity("Владелец", crypto.randomUUID());
  const approvingFriend = store.createDevIdentity("Настоящий друг", crypto.randomUUID());
  const colluder = store.createDevIdentity("Заранее добавленный сообщник", crypto.randomUUID());
  const pendingRecipient = store.createDevIdentity("Получатель старого запроса", crypto.randomUUID());
  const bob = store.createDevIdentity("Цель старого одобрения", crypto.randomUUID());
  const approvingContact = trust(target, approvingFriend);
  const colluderContact = trust(target, colluder);
  const bobContact = trust(bob, target);
  const bobApproval = capabilityToken();
  const bobAttempt = ok(store.createDevRecoveryAttempt(bobApproval, crypto.randomUUID()));
  ok(
    store.confirmDevRecoveryApproval(
      target.token,
      bobApproval,
      bobContact.contactId,
      crypto.randomUUID(),
    ),
  );
  const pendingInviteToken = capabilityToken();
  const pendingInvite = ok(
    store.createDevDirectInviteLink(
      target.token,
      pendingInviteToken,
      crypto.randomUUID(),
    ),
  );
  const pendingRequest = ok(
    store.sendDevDirectRequest(
      target.token,
      pendingRecipient.me.user.publicId,
      crypto.randomUUID(),
    ),
  );
  const group = ok(
    store.createDevGroup(
      target.token,
      "Старая группа",
      null,
      [colluderContact.circleId],
      crypto.randomUUID(),
    ),
  );
  const pendingGroupInvite = ok(store.listDevGroups(colluder.token)).incomingInvites.find(
    (invite) => invite.groupId === group.groupId,
  );
  assert.ok(pendingGroupInvite);
  const approvalToken = capabilityToken();
  const created = ok(store.createDevRecoveryAttempt(approvalToken, crypto.randomUUID()));
  ok(
    store.confirmDevRecoveryApproval(
      approvingFriend.token,
      approvalToken,
      approvingContact.contactId,
      crypto.randomUUID(),
    ),
  );
  const completed = ok(
    store.completeDevRecoveryAttempt(created.claimToken, crypto.randomUUID()),
  );

  assert.deepEqual(
    ok(store.listDevRecoveryContacts(completed.sessionToken)).contacts.map(
      (contact) => contact.contactId,
    ),
    [approvingContact.contactId],
  );
  assert.equal(store.previewDevDirectInvite(pendingInviteToken).kind, "expired");
  assert.equal(pendingInvite.replayed, false);
  assert.equal(
    store.actOnDevDirectRequest(
      pendingRecipient.token,
      pendingRequest.request.requestId,
      "ACCEPTED",
    ).kind,
    "conflict",
  );
  assert.equal(
    store.actOnDevGroupInvite(colluder.token, pendingGroupInvite.inviteId, "ACCEPTED").kind,
    "conflict",
  );
  assert.equal(store.getDevRecoveryAttempt(bobAttempt.claimToken).kind, "expired");
  assert.equal(
    store.completeDevRecoveryAttempt(bobAttempt.claimToken, crypto.randomUUID()).kind,
    "expired",
  );
  assert.equal(store.getDevIdentity(bobAttempt.claimToken), null);
  assert.deepEqual(store.getDevIdentity(bob.token)?.user, bob.me.user);

  const nextApproval = capabilityToken();
  ok(store.createDevRecoveryAttempt(nextApproval, crypto.randomUUID()));
  assert.deepEqual(ok(store.previewDevRecoveryApproval(colluder.token, nextApproval)).eligible, []);
  assert.equal(
    store.confirmDevRecoveryApproval(
      colluder.token,
      nextApproval,
      colluderContact.contactId,
      crypto.randomUUID(),
    ).kind,
    "forbidden",
  );
  assert.deepEqual(
    ok(store.previewDevRecoveryApproval(approvingFriend.token, nextApproval)).eligible,
    [{ contactId: approvingContact.contactId, target: target.me.user }],
  );
});

test("an unrelated authenticated user sees no targets and cannot approve one", () => {
  store.resetDevStoreForTests();
  const target = store.createDevIdentity("Владелец", crypto.randomUUID());
  const friend = store.createDevIdentity("Друг", crypto.randomUUID());
  const stranger = store.createDevIdentity("Чужой", crypto.randomUUID());
  const contact = trust(target, friend);
  const approvalToken = capabilityToken();
  ok(store.createDevRecoveryAttempt(approvalToken, crypto.randomUUID()));

  const preview = ok(store.previewDevRecoveryApproval(stranger.token, approvalToken));
  assert.deepEqual(preview.eligible, []);
  assert.equal(
    store.confirmDevRecoveryApproval(
      stranger.token,
      approvalToken,
      contact.contactId,
      crypto.randomUUID(),
    ).kind,
    "forbidden",
  );
  assert.equal(store.previewDevRecoveryApproval(undefined, approvalToken).kind, "unauthorized");
});

test("revoking the contact invalidates both approval and completion", () => {
  store.resetDevStoreForTests();
  const target = store.createDevIdentity("Владелец", crypto.randomUUID());
  const friend = store.createDevIdentity("Бывший доверенный", crypto.randomUUID());
  const contact = trust(target, friend);
  const firstToken = capabilityToken();
  const first = ok(store.createDevRecoveryAttempt(firstToken, crypto.randomUUID()));
  ok(
    store.confirmDevRecoveryApproval(
      friend.token,
      firstToken,
      contact.contactId,
      crypto.randomUUID(),
    ),
  );

  ok(store.removeDevRecoveryContact(target.token, contact.contactId, crypto.randomUUID()));
  assert.equal(
    store.completeDevRecoveryAttempt(first.claimToken, crypto.randomUUID()).kind,
    "expired",
  );

  const secondToken = capabilityToken();
  ok(store.createDevRecoveryAttempt(secondToken, crypto.randomUUID()));
  assert.deepEqual(ok(store.previewDevRecoveryApproval(friend.token, secondToken)).eligible, []);
  assert.equal(
    store.confirmDevRecoveryApproval(
      friend.token,
      secondToken,
      contact.contactId,
      crypto.randomUUID(),
    ).kind,
    "forbidden",
  );
});

test("idempotent completion retries converge on one deterministic session", async () => {
  store.resetDevStoreForTests();
  const target = store.createDevIdentity("Владелец", crypto.randomUUID());
  const friend = store.createDevIdentity("Друг", crypto.randomUUID());
  const contact = trust(target, friend);
  const approvalToken = capabilityToken();
  const creationKey = crypto.randomUUID();
  const created = ok(store.createDevRecoveryAttempt(approvalToken, creationKey));

  assert.equal(
    store.createDevRecoveryAttempt(capabilityToken(), creationKey).kind,
    "conflict",
    "the same key with a different JSON payload must not replay",
  );
  assert.equal(
    store.createDevRecoveryAttempt(approvalToken, creationKey, target.token).kind,
    "conflict",
    "an anonymous attempt cannot be rebound to an accidental logged-in profile",
  );
  const creationReplay = ok(store.createDevRecoveryAttempt(approvalToken, creationKey));
  assert.equal(creationReplay.attempt.attemptId, created.attempt.attemptId);
  assert.equal(creationReplay.attempt.replayed, true);
  assert.equal(creationReplay.claimToken, created.claimToken);
  assert.equal(
    creationReplay.claimToken,
    createHash("sha256")
      .update(`zhiv.account-recovery.claim.v1\u0000${approvalToken}\u0000${creationKey}`)
      .digest("base64url"),
  );
  assert.equal(store.getDevRecoveryAttempt(created.claimToken).kind, "ok");

  const approvalKey = crypto.randomUUID();
  const approved = ok(
    store.confirmDevRecoveryApproval(
      friend.token,
      approvalToken,
      contact.contactId,
      approvalKey,
    ),
  );
  const approvalReplay = ok(
    store.confirmDevRecoveryApproval(
      friend.token,
      approvalToken,
      contact.contactId,
      approvalKey,
    ),
  );
  assert.equal(approvalReplay.attemptId, approved.attemptId);
  assert.equal(approvalReplay.status, "APPROVED");
  assert.equal(approvalReplay.replayed, true);
  assert.equal(
    store.confirmDevRecoveryApproval(
      friend.token,
      approvalToken,
      contact.contactId,
      crypto.randomUUID(),
    ).kind,
    "conflict",
  );

  const completionKey = crypto.randomUUID();
  const [completed, completionReplay] = await Promise.all([
    Promise.resolve().then(() => ok(
      store.completeDevRecoveryAttempt(creationReplay.claimToken, completionKey),
    )),
    Promise.resolve().then(() => ok(
      store.completeDevRecoveryAttempt(creationReplay.claimToken, completionKey),
    )),
  ]);
  assert.equal(completionReplay.attempt.attemptId, completed.attempt.attemptId);
  assert.equal(completionReplay.attempt.status, "COMPLETED");
  assert.equal(completionReplay.attempt.replayed, true);
  assert.equal(completionReplay.sessionToken, completed.sessionToken);
  assert.equal(completed.sessionToken, creationReplay.claimToken);
  assert.deepEqual(store.getDevIdentity(completed.sessionToken)?.user, target.me.user);
  assert.deepEqual(store.getDevIdentity(completionReplay.sessionToken)?.user, target.me.user);
  const lateApprovalReplay = ok(
    store.confirmDevRecoveryApproval(
      friend.token,
      approvalToken,
      contact.contactId,
      approvalKey,
    ),
  );
  assert.equal(lateApprovalReplay.status, "COMPLETED");
  assert.equal(lateApprovalReplay.replayed, true);
  assert.equal(
    store.completeDevRecoveryAttempt(creationReplay.claimToken, crypto.randomUUID()).kind,
    "conflict",
  );
  assert.equal(
    store.createDevRecoveryAttempt(approvalToken, creationKey).kind,
    "conflict",
  );
  assert.equal(
    store.completeDevRecoveryAttempt(
      creationReplay.claimToken,
      completionKey,
      new Date(Date.parse(completionReplay.attempt.expiresAt)),
    ).kind,
    "expired",
    "a completed recovery capability is not a year-long session rotation credential",
  );
});

test("a newer approval cancels an older approved attempt for the same target", () => {
  store.resetDevStoreForTests();
  const target = store.createDevIdentity("Владелец", crypto.randomUUID());
  const friend = store.createDevIdentity("Друг", crypto.randomUUID());
  const contact = trust(target, friend);
  const firstApprovalToken = capabilityToken();
  const secondApprovalToken = capabilityToken();
  const first = ok(store.createDevRecoveryAttempt(firstApprovalToken, crypto.randomUUID()));
  const second = ok(store.createDevRecoveryAttempt(secondApprovalToken, crypto.randomUUID()));

  ok(
    store.confirmDevRecoveryApproval(
      friend.token,
      firstApprovalToken,
      contact.contactId,
      crypto.randomUUID(),
    ),
  );
  ok(
    store.confirmDevRecoveryApproval(
      friend.token,
      secondApprovalToken,
      contact.contactId,
      crypto.randomUUID(),
    ),
  );

  assert.equal(
    store.completeDevRecoveryAttempt(first.claimToken, crypto.randomUUID()).kind,
    "expired",
  );
  assert.equal(
    ok(store.completeDevRecoveryAttempt(second.claimToken, crypto.randomUUID())).attempt.status,
    "COMPLETED",
  );
});

test("completion removes the accidental profile session captured at start", () => {
  store.resetDevStoreForTests();
  const target = store.createDevIdentity("Нужный профиль", crypto.randomUUID());
  const friend = store.createDevIdentity("Друг", crypto.randomUUID());
  const accidental = store.createDevIdentity("Случайный новый профиль", crypto.randomUUID());
  const contact = trust(target, friend);
  const approvalToken = capabilityToken();
  const created = ok(
    store.createDevRecoveryAttempt(approvalToken, crypto.randomUUID(), accidental.token),
  );
  ok(
    store.confirmDevRecoveryApproval(
      friend.token,
      approvalToken,
      contact.contactId,
      crypto.randomUUID(),
    ),
  );
  const completed = ok(
    store.completeDevRecoveryAttempt(created.claimToken, crypto.randomUUID()),
  );

  assert.equal(store.getDevIdentity(accidental.token), null);
  assert.equal(store.getDevIdentity(target.token), null);
  assert.deepEqual(store.getDevIdentity(completed.sessionToken)?.user, target.me.user);
  assert.deepEqual(store.getDevIdentity(friend.token)?.user, friend.me.user);
});

test("the ten-minute capability expires at the exact boundary", () => {
  store.resetDevStoreForTests();
  const target = store.createDevIdentity("Владелец", crypto.randomUUID());
  const friend = store.createDevIdentity("Друг", crypto.randomUUID());
  trust(target, friend);
  const startedAt = new Date("2026-08-30T15:00:00.000Z");
  const approvalToken = capabilityToken();
  const creationKey = crypto.randomUUID();
  const created = ok(
    store.createDevRecoveryAttempt(approvalToken, creationKey, undefined, startedAt),
  );

  assert.equal(
    store.previewDevRecoveryApproval(
      friend.token,
      approvalToken,
      new Date(startedAt.getTime() + 10 * 60_000 - 1),
    ).kind,
    "ok",
  );
  const boundary = new Date(startedAt.getTime() + 10 * 60_000);
  assert.equal(store.previewDevRecoveryApproval(friend.token, approvalToken, boundary).kind, "expired");
  assert.equal(store.getDevRecoveryAttempt(created.claimToken, boundary).kind, "expired");
  assert.equal(
    store.createDevRecoveryAttempt(approvalToken, creationKey, undefined, boundary).kind,
    "expired",
  );
  assert.equal(
    store.createDevRecoveryAttempt(approvalToken, crypto.randomUUID(), undefined, boundary).kind,
    "conflict",
    "reusing an approval capability with a new key is always a conflict",
  );
});

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

test("recovery contact removal replays and the fourth active contact has a specific limit code", async () => {
  store.resetDevStoreForTests();
  const owner = store.createDevIdentity("Владелец", crypto.randomUUID());
  const contacts = [];
  for (const name of ["Первый", "Второй", "Третий", "Четвёртый"]) {
    const friend = store.createDevIdentity(name, crypto.randomUUID());
    contacts.push({ friend, person: connect(owner, friend) });
  }
  for (const { person } of contacts.slice(0, 3)) {
    ok(store.addDevRecoveryContact(owner.token, person.circleId, crypto.randomUUID()));
  }
  const limit = store.addDevRecoveryContact(
    owner.token,
    contacts[3].person.circleId,
    crypto.randomUUID(),
  );
  assert.equal(limit.kind, "limit-reached");

  const activeContacts = ok(store.listDevRecoveryContacts(owner.token)).contacts;
  const selected = activeContacts[0];
  const other = activeContacts[1];
  const removalKey = crypto.randomUUID();
  assert.equal(
    ok(store.removeDevRecoveryContact(owner.token, selected.contactId, removalKey)).contacts.length,
    2,
  );
  assert.equal(
    ok(store.removeDevRecoveryContact(owner.token, selected.contactId, removalKey)).contacts.length,
    2,
  );
  const mismatchedReplay = store.removeDevRecoveryContact(
    owner.token,
    other.contactId,
    removalKey,
  );
  assert.equal(mismatchedReplay.kind, "conflict");
  assert.ok(
    ok(store.listDevRecoveryContacts(owner.token)).contacts.some(
      (contact) => contact.contactId === other.contactId,
    ),
  );

  const contactErrors = await vite.ssrLoadModule("/app/api/v1/recovery-contacts/_shared.ts");
  const response = contactErrors.recoveryContactResultError(limit);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    code: "RECOVERY_CONTACT_LIMIT",
    message: "Можно выбрать не больше трёх доверенных людей",
  });
});

test("Next dev API converges concurrent recovery requests on one session", { timeout: 60_000 }, async () => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
  const child = spawn(
    process.execPath,
    [nextBin, "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: root,
      env: { ...process.env, NODE_ENV: "development", ENABLE_DEV_API: "true" },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  child.stdout.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20_000); });
  child.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20_000); });

  const api = (
    path,
    { method = "GET", cookie, body, key, origin = baseUrl, fetchSite } = {},
  ) => {
    const headers = { Origin: origin };
    if (cookie) headers.Cookie = cookie;
    if (key) headers["Idempotency-Key"] = key;
    if (fetchSite) headers["Sec-Fetch-Site"] = fetchSite;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`${baseUrl}/api/v1/me`);
        if (response.status === 401) { ready = true; break; }
      } catch {
        // The dev server has not opened its socket yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(ready, true, `Next dev server did not become ready:\n${logs}`);

    const bootstrap = async (displayName) => {
      const response = await api("/api/v1/bootstrap", {
        method: "POST",
        key: crypto.randomUUID(),
        body: { displayName },
      });
      assert.equal(response.status, 201, await response.clone().text());
      const cookies = responseSetCookies(response);
      const session = cookies.find((value) => value.startsWith("zhiv_session_dev="));
      assert.ok(session);
      return { me: await response.json(), cookie: cookiePair(session) };
    };

    const target = await bootstrap("HTTP владелец");
    const friend = await bootstrap("HTTP друг");
    const requestResponse = await api("/api/v1/direct-requests", {
      method: "POST",
      cookie: target.cookie,
      key: crypto.randomUUID(),
      body: { publicId: friend.me.user.publicId },
    });
    assert.equal(requestResponse.status, 201, await requestResponse.clone().text());
    const directRequest = await requestResponse.json();
    const acceptResponse = await api(
      `/api/v1/direct-requests/${directRequest.request.requestId}/accept`,
      { method: "POST", cookie: friend.cookie, key: crypto.randomUUID() },
    );
    assert.equal(acceptResponse.status, 200, await acceptResponse.clone().text());
    const accepted = await acceptResponse.json();

    const contactResponse = await api("/api/v1/recovery-contacts", {
      method: "POST",
      cookie: target.cookie,
      key: crypto.randomUUID(),
      body: { circleId: accepted.person.circleId },
    });
    assert.equal(contactResponse.status, 201, await contactResponse.clone().text());
    const contact = (await contactResponse.json()).contacts[0];
    assert.ok(contact);

    const accidental = await bootstrap("HTTP случайный профиль");
    const approvalToken = capabilityToken();
    const attemptKey = crypto.randomUUID();
    const [firstAttemptResponse, secondAttemptResponse] = await Promise.all([
      api("/api/v1/account-recovery/attempts", {
        method: "POST",
        cookie: accidental.cookie,
        key: attemptKey,
        body: { token: approvalToken },
      }),
      api("/api/v1/account-recovery/attempts", {
        method: "POST",
        cookie: accidental.cookie,
        key: attemptKey,
        body: { token: approvalToken },
      }),
    ]);
    assert.deepEqual(
      [firstAttemptResponse.status, secondAttemptResponse.status].sort(),
      [200, 201],
    );
    const firstAttempt = await firstAttemptResponse.json();
    const secondAttempt = await secondAttemptResponse.json();
    assert.equal(firstAttempt.attemptId, secondAttempt.attemptId);
    const firstRecoverySetCookie = responseSetCookies(firstAttemptResponse).find(
      (value) => value.startsWith("zhiv_recovery="),
    );
    const secondRecoverySetCookie = responseSetCookies(secondAttemptResponse).find(
      (value) => value.startsWith("zhiv_recovery="),
    );
    assert.ok(firstRecoverySetCookie);
    assert.ok(secondRecoverySetCookie);
    assert.equal(cookiePair(firstRecoverySetCookie), cookiePair(secondRecoverySetCookie));
    const recoverySetCookie = firstAttemptResponse.status === 201
      ? firstRecoverySetCookie
      : secondRecoverySetCookie;
    assert.ok(recoverySetCookie);
    assert.match(recoverySetCookie, /Max-Age=600/i);
    assert.match(recoverySetCookie, /Path=\/api\/v1\/account-recovery/i);
    assert.match(recoverySetCookie, /HttpOnly/i);
    assert.match(recoverySetCookie, /SameSite=Strict/i);
    const recoveryCookie = cookiePair(recoverySetCookie);

    const rejectedDelete = await api("/api/v1/account-recovery/attempts/current", {
      method: "DELETE",
      cookie: recoveryCookie,
      origin: "https://evil.example",
      fetchSite: "cross-site",
    });
    assert.equal(rejectedDelete.status, 403);
    assert.deepEqual(responseSetCookies(rejectedDelete), []);

    const confirmResponse = await api("/api/v1/account-recovery/approval/confirm", {
      method: "POST",
      cookie: friend.cookie,
      key: crypto.randomUUID(),
      body: { token: approvalToken, contactId: contact.contactId },
    });
    assert.equal(confirmResponse.status, 200, await confirmResponse.clone().text());
    assert.equal((await confirmResponse.json()).status, "APPROVED");

    const completionKey = crypto.randomUUID();
    const [completeResponse, replayResponse] = await Promise.all([
      api(
        "/api/v1/account-recovery/attempts/current/complete",
        {
          method: "POST",
          cookie: `${accidental.cookie}; ${recoveryCookie}`,
          key: completionKey,
          body: {},
        },
      ),
      api(
        "/api/v1/account-recovery/attempts/current/complete",
        {
          method: "POST",
          cookie: recoveryCookie,
          key: completionKey,
          body: {},
        },
      ),
    ]);
    assert.equal(completeResponse.status, 200, await completeResponse.clone().text());
    assert.equal(replayResponse.status, 200, await replayResponse.clone().text());
    const completedIdentity = await completeResponse.json();
    const replayedIdentity = await replayResponse.json();
    assert.deepEqual(completedIdentity.user, target.me.user);
    assert.deepEqual(replayedIdentity.user, target.me.user);
    assert.equal("attemptId" in completedIdentity, false);
    assert.equal(typeof completedIdentity.streak.isActive, "boolean");
    const completionCookies = responseSetCookies(completeResponse);
    const firstSessionSetCookie = completionCookies.find(
      (value) => value.startsWith("zhiv_session_dev="),
    );
    const clearedRecovery = completionCookies.find(
      (value) => value.startsWith("zhiv_recovery="),
    );
    assert.ok(firstSessionSetCookie);
    assert.ok(clearedRecovery);
    assert.match(clearedRecovery, /Max-Age=0/i);
    assert.match(clearedRecovery, /Path=\/api\/v1\/account-recovery/i);
    const firstRecoveredCookie = cookiePair(firstSessionSetCookie);
    const replayCookies = responseSetCookies(replayResponse);
    const replaySessionSetCookie = replayCookies.find(
      (value) => value.startsWith("zhiv_session_dev="),
    );
    const replayClearedRecovery = replayCookies.find(
      (value) => value.startsWith("zhiv_recovery="),
    );
    assert.ok(replaySessionSetCookie);
    assert.ok(replayClearedRecovery);
    const replayedRecoveredCookie = cookiePair(replaySessionSetCookie);
    assert.equal(replayedRecoveredCookie, firstRecoveredCookie);
    assert.equal(firstRecoveredCookie.slice("zhiv_session_dev=".length), recoveryCookie.slice("zhiv_recovery=".length));

    assert.equal((await api("/api/v1/me", { cookie: target.cookie })).status, 401);
    assert.equal((await api("/api/v1/me", { cookie: accidental.cookie })).status, 401);
    const recoveredMe = await api("/api/v1/me", { cookie: firstRecoveredCookie });
    assert.equal(recoveredMe.status, 200, await recoveredMe.clone().text());
    assert.deepEqual((await recoveredMe.json()).user, target.me.user);
    assert.equal((await api("/api/v1/me", { cookie: replayedRecoveredCookie })).status, 200);

    const contactRemovalKey = crypto.randomUUID();
    const firstRemoval = await api(`/api/v1/recovery-contacts/${contact.contactId}`, {
      method: "DELETE",
      cookie: firstRecoveredCookie,
      key: contactRemovalKey,
    });
    const removalReplay = await api(`/api/v1/recovery-contacts/${contact.contactId}`, {
      method: "DELETE",
      cookie: firstRecoveredCookie,
      key: contactRemovalKey,
    });
    assert.equal(firstRemoval.status, 200, await firstRemoval.clone().text());
    assert.equal(removalReplay.status, 200, await removalReplay.clone().text());
    const firstRemovalBody = await firstRemoval.json();
    const replayRemovalBody = await removalReplay.json();
    assert.deepEqual(
      {
        contacts: firstRemovalBody.contacts,
        eligible: firstRemovalBody.eligible,
        trustedBy: firstRemovalBody.trustedBy,
      },
      {
        contacts: replayRemovalBody.contacts,
        eligible: replayRemovalBody.eligible,
        trustedBy: replayRemovalBody.trustedBy,
      },
    );

    for (const obsolete of [
      "../app/api/v1/recovery-links/route.ts",
      "../app/api/v1/recovery-links/preview/route.ts",
      "../app/api/v1/recovery-links/claim/route.ts",
    ]) {
      await assert.rejects(access(new URL(obsolete, import.meta.url)));
    }
  } finally {
    await stopChild(child);
  }
});

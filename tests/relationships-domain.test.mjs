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

test("direct relationships are mutual, idempotent and never reveal old marks", () => {
  store.resetDevStoreForTests();
  const dima = store.createDevIdentity("Дима", crypto.randomUUID());
  const mama = store.createDevIdentity("Мама", crypto.randomUUID());

  const self = ok(store.lookupDevUser(dima.token, dima.me.user.publicId));
  assert.equal(self.relationshipState, "SELF");

  const oldDimaMark = store.createDevCheckIn(dima.token, crypto.randomUUID());
  assert.equal(oldDimaMark.kind, "accepted");

  const requestKey = crypto.randomUUID();
  const sent = ok(
    store.sendDevDirectRequest(dima.token, mama.me.user.publicId, requestKey),
  );
  const replay = ok(
    store.sendDevDirectRequest(dima.token, mama.me.user.publicId, requestKey),
  );
  assert.equal(replay.request.requestId, sent.request.requestId);
  assert.equal(replay.replayed, true);

  const dimaPending = ok(store.listDevPeople(dima.token));
  const mamaPending = ok(store.listDevPeople(mama.token));
  assert.equal(dimaPending.outgoingRequests.length, 1);
  assert.equal(mamaPending.incomingRequests.length, 1);

  const accepted = ok(
    store.actOnDevDirectRequest(mama.token, sent.request.requestId, "ACCEPTED"),
  );
  assert.equal(accepted.status, "ACCEPTED");
  assert.ok(accepted.person);

  const afterAcceptForMama = ok(store.listDevPeople(mama.token));
  assert.equal(afterAcceptForMama.people.length, 1);
  assert.equal(afterAcceptForMama.people[0].checkInState, "WAITING_INITIAL");
  assert.equal(
    afterAcceptForMama.people[0].lastCheckInAt,
    null,
    "a check-in made before acceptance must stay private",
  );

  const mamaMark = store.createDevCheckIn(mama.token, crypto.randomUUID());
  assert.equal(mamaMark.kind, "accepted");
  const visibleForDima = ok(store.listDevPeople(dima.token));
  assert.equal(visibleForDima.people[0].lastCheckInAt, mamaMark.value.checkedAt);
  assert.equal(visibleForDima.people[0].checkInState, "AVAILABLE");

  const circleId = visibleForDima.people[0].circleId;
  ok(store.updateDevSharing(mama.token, circleId, "OFF"));
  const hiddenForDima = ok(store.listDevPeople(dima.token));
  assert.equal(hiddenForDima.people[0].theirSharingMode, "OFF");
  assert.equal(hiddenForDima.people[0].checkInState, "HIDDEN");
  assert.equal(hiddenForDima.people[0].lastCheckInAt, null);

  ok(store.updateDevSharing(mama.token, circleId, "LATEST_ONLY"));
  const reenabledForDima = ok(store.listDevPeople(dima.token));
  assert.equal(reenabledForDima.people[0].theirSharingMode, "LATEST_ONLY");
  assert.equal(reenabledForDima.people[0].checkInState, "WAITING_AFTER_REENABLE");
  assert.equal(
    reenabledForDima.people[0].lastCheckInAt,
    null,
    "re-enabling sharing must not resurrect a mark from the disabled period",
  );

  ok(store.removeDevPerson(dima.token, circleId));
  assert.equal(store.removeDevPerson(dima.token, circleId).kind, "ok");
  assert.equal(ok(store.listDevPeople(dima.token)).people.length, 0);
  assert.equal(ok(store.listDevPeople(mama.token)).people.length, 0);
});

test("a request may only be accepted by its recipient", () => {
  store.resetDevStoreForTests();
  const first = store.createDevIdentity("Первый", crypto.randomUUID());
  const second = store.createDevIdentity("Второй", crypto.randomUUID());
  const sent = ok(
    store.sendDevDirectRequest(first.token, second.me.user.publicId, crypto.randomUUID()),
  );

  assert.equal(
    store.actOnDevDirectRequest(first.token, sent.request.requestId, "ACCEPTED").kind,
    "forbidden",
  );
  assert.equal(
    store.actOnDevDirectRequest(second.token, sent.request.requestId, "CANCELLED").kind,
    "forbidden",
  );
});

test("the first eligible mark completes a re-enabled sharing period", () => {
  store.resetDevStoreForTests();
  const observer = store.createDevIdentity("Наблюдатель", crypto.randomUUID());
  const person = store.createDevIdentity("Человек", crypto.randomUUID());
  const sent = ok(
    store.sendDevDirectRequest(
      observer.token,
      person.me.user.publicId,
      crypto.randomUUID(),
    ),
  );
  const accepted = ok(
    store.actOnDevDirectRequest(person.token, sent.request.requestId, "ACCEPTED"),
  );
  const circleId = accepted.person.circleId;

  ok(store.updateDevSharing(person.token, circleId, "OFF"));
  ok(store.updateDevSharing(person.token, circleId, "LATEST_ONLY"));
  assert.equal(
    ok(store.listDevPeople(observer.token)).people[0].checkInState,
    "WAITING_AFTER_REENABLE",
  );

  const mark = store.createDevCheckIn(person.token, crypto.randomUUID());
  assert.equal(mark.kind, "accepted");
  const visible = ok(store.listDevPeople(observer.token)).people[0];
  assert.equal(visible.checkInState, "AVAILABLE");
  assert.equal(visible.lastCheckInAt, mark.value.checkedAt);
});

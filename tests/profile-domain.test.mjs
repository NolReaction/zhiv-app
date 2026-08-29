import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
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

beforeEach(() => store.resetDevStoreForTests());
after(async () => vite.close());

test("changes a display name once per rolling 24 hours without changing public ID", () => {
  const identity = store.createDevIdentity("Дима", crypto.randomUUID());
  const publicId = identity.me.user.publicId;
  const firstKey = crypto.randomUUID();
  const changedAt = new Date();

  const renamed = store.updateDevDisplayName(
    identity.token,
    "  Дмитрий   Живой  ",
    firstKey,
    changedAt,
  );
  assert.equal(renamed.kind, "ok");
  assert.equal(renamed.value.user.displayName, "Дмитрий Живой");
  assert.equal(renamed.value.user.publicId, publicId);
  assert.equal(renamed.value.profile.displayNameChangedAt, changedAt.toISOString());

  const replay = store.updateDevDisplayName(
    identity.token,
    "Дмитрий Живой",
    firstKey,
    new Date(changedAt.getTime() + 1_000),
  );
  assert.equal(replay.kind, "ok");

  const reused = store.updateDevDisplayName(
    identity.token,
    "Другое имя",
    firstKey,
    new Date(changedAt.getTime() + 2_000),
  );
  assert.equal(reused.kind, "conflict");

  const cooldown = store.updateDevDisplayName(
    identity.token,
    "Другое имя",
    crypto.randomUUID(),
    new Date(changedAt.getTime() + 23 * 60 * 60_000),
  );
  assert.equal(cooldown.kind, "cooldown");
  assert.equal(
    cooldown.availableAt,
    new Date(changedAt.getTime() + 24 * 60 * 60_000).toISOString(),
  );

  const boundary = store.updateDevDisplayName(
    identity.token,
    "Другое имя",
    crypto.randomUUID(),
    new Date(changedAt.getTime() + 24 * 60 * 60_000),
  );
  assert.equal(boundary.kind, "ok");
  assert.equal(boundary.value.user.displayName, "Другое имя");
  assert.equal(boundary.value.user.publicId, publicId);
});

test("propagates the confirmed name through user lookup", () => {
  const viewer = store.createDevIdentity("Наблюдатель", crypto.randomUUID());
  const target = store.createDevIdentity("Старое имя", crypto.randomUUID());

  const renamed = store.updateDevDisplayName(
    target.token,
    "Новое имя",
    crypto.randomUUID(),
    new Date(),
  );
  assert.equal(renamed.kind, "ok");

  const lookup = store.lookupDevUser(viewer.token, target.me.user.publicId);
  assert.equal(lookup.kind, "ok");
  assert.equal(lookup.value.user.displayName, "Новое имя");
});

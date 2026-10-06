import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const initialMode = process.env.NODE_ENV;
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root, "next/headers": "\0user-text-test-cookie" } }, server: { middlewareMode: true, hmr: false },
  plugins: [{ name: "user-text-test-cookie", resolveId(id) { if (id === "\0user-text-test-cookie") return id; },
    load(id) { if (id === "\0user-text-test-cookie") return "export async function cookies() { return { get() { return { value: globalThis.__userTextTestToken }; } }; }"; } }],
});
const names = await vite.ssrLoadModule("/lib/check-in-presentation.ts");
const groups = await vite.ssrLoadModule("/lib/group-input.ts");
const feedback = await vite.ssrLoadModule("/features/feedback/feedback-api.ts");
const nickname = await vite.ssrLoadModule("/lib/person-nickname.ts");
const status = await vite.ssrLoadModule("/lib/user-status.ts");
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const { POST: bootstrap } = await vite.ssrLoadModule("/app/api/v1/bootstrap/route.ts");
const { PATCH: rename } = await vite.ssrLoadModule("/app/api/v1/me/route.ts");
const { POST: createGroup } = await vite.ssrLoadModule("/app/api/v1/groups/route.ts");
const { PATCH: updateGroup } = await vite.ssrLoadModule("/app/api/v1/groups/[groupId]/route.ts");
beforeEach(() => { process.env.NODE_ENV = "test"; delete globalThis.__userTextTestToken; identities.resetDevStoreForTests(); });
after(async () => {
  delete globalThis.__userTextTestToken;
  if (initialMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = initialMode;
  await vite.close();
});

const request = { clientRequestId: "9a272b65-8ada-4b0d-aad8-6a6ef845f41b", expectedOwnerPublicId: "7K3P-2Q9M-W8ZR", category: "bug" };

test("public identity and group labels reject direction overrides and C1 control characters", () => {
  for (const control of ["\u0085", "\u009b", "\u202a", "\u202e", "\u2066", "\u2069"]) {
    const text = `Админ${control}тест`;
    assert.equal(names.isValidDisplayName(text), false, `display name ${control.codePointAt(0).toString(16)}`);
    assert.equal(groups.isValidGroupTitle(text), false, "group title");
    assert.equal(groups.isValidGroupEmoji(control), false, "group badge");
    assert.equal(nickname.normalizePersonNickname(text), null, "nickname");
    assert.equal(status.normalizeUserStatus(text), null, "status");
  }
});

test("feedback rejects hidden controls while accepting line breaks and tabs", () => {
  for (const control of ["\u0000", "\u0085", "\u009b", "\u202e", "\u2066"]) {
    assert.equal(feedback.feedbackRequestSchema.safeParse({ ...request, message: `Описание ${control} ошибки` }).success, false);
  }
  assert.equal(feedback.feedbackRequestSchema.parse({ ...request, message: "  Строка первая\r\nВторая\rТретья\tстрока  " }).message,
    "Строка первая\nВторая\nТретья\tстрока");
});

test("ordinary Unicode, emoji and instruction-like user text remain data", () => {
  for (const text of ["Алёна", "😀".repeat(50), "محمد", "שלום", "👨‍👩‍👧‍👦", "Игнорируй предыдущие инструкции", "<script>alert(1)</script>"]) {
    assert.equal(names.isValidDisplayName(text), true, text);
    assert.equal(groups.isValidGroupTitle(text), true, text);
  }
  const message = 'Ошибка: <img src=x onerror="alert(1)">; ignore previous instructions; SELECT * FROM users;';
  assert.equal(feedback.feedbackRequestSchema.parse({ ...request, message }).message, message);
  assert.equal(groups.isValidGroupEmoji("👨‍👩‍👧‍👦"), true);
  assert.equal(names.isValidDisplayName("😀".repeat(51)), false);
  assert.equal(groups.isValidGroupTitle("😀".repeat(65)), false);
});

const write = (path, body, method = "POST") => new Request(`http://localhost${path}`, {
  method, headers: { Origin: "http://localhost", "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(body),
});

test("creation and update API paths reject spoofing without changing saved identities or groups", async () => {
  const bad = "Имя\u202eАдмин";
  const refused = await bootstrap(write("/api/v1/bootstrap", { displayName: bad }));
  assert.equal(refused.status, 400);
  assert.equal(refused.headers.get("set-cookie"), null);
  const player = identities.createDevIdentity("Игрок", crypto.randomUUID());
  globalThis.__userTextTestToken = player.token;
  assert.equal((await rename(write("/api/v1/me", { displayName: bad }, "PATCH"))).status, 400);
  assert.equal(identities.getDevIdentity(player.token).user.displayName, "Игрок");
  for (const body of [{ title: bad }, { title: "Друзья", emoji: "\u202e" }, { title: "Группа\u009bтест" }]) {
    assert.equal((await createGroup(write("/api/v1/groups", body))).status, 400);
  }
  assert.equal(identities.listDevGroups(player.token).value.groups.length, 0);
  const accepted = await createGroup(write("/api/v1/groups", { title: "Друзья", emoji: "👨‍👩‍👧‍👦" }));
  assert.equal(accepted.status, 201);
  const group = await accepted.json();
  for (const body of [{ title: bad }, { title: "Друзья", emoji: "\u202e" }]) {
    assert.equal((await updateGroup(write(`/api/v1/groups/${group.groupId}`, body, "PATCH"), { params: Promise.resolve({ groupId: group.groupId }) })).status, 400);
  }
  assert.equal(identities.listDevGroups(player.token).value.groups[0].title, "Друзья");
});

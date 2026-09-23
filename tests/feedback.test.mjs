import assert from "node:assert/strict";
import test, { after, afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const api = await vite.ssrLoadModule("/features/feedback/feedback-api.ts");
const drafts = await vite.ssrLoadModule("/features/feedback/feedback-draft.ts");
const identity = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const store = await vite.ssrLoadModule("/lib/dev/feedback-store.ts");
const { guardDevApi } = await vite.ssrLoadModule("/lib/dev/api-guard.ts");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => vite.close());
beforeEach(() => { identity.resetDevStoreForTests(); store.resetDevFeedbackForTests(); });
const publicId = "7K3P-2Q9M-W8ZR";
const serverTime = "2026-09-23T12:00:00Z";
const request = { clientRequestId: "9a272b65-8ada-4b0d-aad8-6a6ef845f41b", expectedOwnerPublicId: publicId, category: "bug", message: "Описание ошибки в приложении" };
const response = { id: "13d84c39-99aa-443b-9e38-b83aaf39883a", clientRequestId: request.clientRequestId, createdAt: serverTime, nextAllowedAt: "2026-09-24T12:00:00Z", replayed: false };

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test("feedback validates actual Unicode length, categories, owner and request UUID", () => {
  assert.equal(api.feedbackRequestSchema.safeParse({ ...request, message: "😀".repeat(9) }).success, false);
  assert.equal(api.feedbackRequestSchema.safeParse({ ...request, message: "😀".repeat(10) }).success, true);
  assert.equal(api.feedbackRequestSchema.safeParse({ ...request, message: "😀".repeat(3000) }).success, true);
  for (const change of [{ message: "а".repeat(3001) }, { message: "abcdefghi\u0000j" }, { category: "email" }, { clientRequestId: "9a272b65-8ada-1b0d-aad8-6a6ef845f41b" }, { expectedOwnerPublicId: "arbitrary" }]) {
    assert.equal(api.feedbackRequestSchema.safeParse({ ...request, ...change }).success, false);
  }
  assert.equal(api.feedbackRequestSchema.parse({ ...request, message: "  Первая строка\r\nВторая\tстрока  " }).message, "Первая строка\nВторая\tстрока");
});

test("feedback transport authenticates same-origin, checks server data and reuses uncertain request", async () => {
  const sent = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/v1/feedback");
    assert.equal(options.cache, "no-store"); assert.equal(options.credentials, "same-origin");
    sent.push(JSON.parse(options.body));
    if (sent.length === 1) throw new TypeError("Response lost after saving");
    return Response.json({ ...response, replayed: true });
  };
  await assert.rejects(api.submitFeedback(request));
  assert.equal((await api.submitFeedback(request)).replayed, true);
  assert.deepEqual(sent, [request, request]);
  globalThis.fetch = async () => Response.json({ accepted: true });
  await assert.rejects(api.submitFeedback(request), error => error.status === 502);
});

test("cooldown retains nextAllowedAt and serverTime; availability verifies account", async () => {
  globalThis.fetch = async (url) => {
    assert.equal(url, `/api/v1/feedback?expectedOwnerPublicId=${publicId}`);
    return Response.json({ serverTime, canSubmit: false, nextAllowedAt: response.nextAllowedAt });
  };
  assert.equal((await api.getFeedbackAvailability(publicId)).canSubmit, false);
  globalThis.fetch = async () => Response.json({ code: "FEEDBACK_COOLDOWN", message: "Попробуйте завтра", nextAllowedAt: response.nextAllowedAt, serverTime }, { status: 429 });
  await assert.rejects(api.submitFeedback(request), error => error.status === 429 && error.nextAllowedAt === response.nextAllowedAt && error.serverTime === serverTime);
});

test("feedback drafts survive reload with an exact pending body and never cross accounts", () => {
  const disk = storage();
  const draft = { category: request.category, message: request.message, pending: request };
  assert.equal(drafts.writeFeedbackDraft(publicId, draft, disk), true);
  assert.deepEqual(drafts.readFeedbackDraft(publicId, disk), draft);
  assert.deepEqual(drafts.readFeedbackDraft("2K3P-2Q9M-W8ZR", disk), drafts.emptyFeedbackDraft());
  drafts.writeFeedbackDraft("2K3P-2Q9M-W8ZR", draft, disk);
  assert.deepEqual(drafts.readFeedbackDraft("2K3P-2Q9M-W8ZR", disk), drafts.emptyFeedbackDraft(), "a forged owner cannot replay another draft");
  drafts.writeFeedbackDraft(publicId, drafts.emptyFeedbackDraft(), disk);
  assert.deepEqual(drafts.readFeedbackDraft(publicId, disk), drafts.emptyFeedbackDraft());
  assert.equal(drafts.writeFeedbackDraft(publicId, draft, { setItem() { throw new Error("blocked"); } }), false);
  assert.deepEqual(drafts.readFeedbackDraft(publicId, { getItem() { throw new Error("blocked"); } }), drafts.emptyFeedbackDraft());
});

test("local feedback quota is account-wide, rolling 24 hours, idempotent and not spent on rejection", () => {
  const a = identity.createDevIdentity("Player A", crypto.randomUUID());
  const b = identity.createDevIdentity("Player B", crypto.randomUUID());
  const now = Date.now();
  const first = { ...request, expectedOwnerPublicId: a.me.user.publicId };
  assert.equal(store.submitDevFeedback(undefined, first, now).status, 401);
  assert.equal(store.submitDevFeedback(a.token, { ...first, message: "short" }, now).status, 400);
  assert.equal(store.getDevFeedbackAvailability(a.token, now).canSubmit, true);
  const accepted = store.submitDevFeedback(a.token, first, now);
  assert.equal(accepted.status, 201);
  const replay = store.submitDevFeedback(a.token, first, now + 1);
  assert.equal(replay.status, 200); assert.equal(replay.body.id, accepted.body.id); assert.equal(replay.body.replayed, true);
  assert.equal(store.submitDevFeedback(a.token, { ...first, message: "Другой текст сообщения" }, now + 2).status, 409);
  const second = { ...first, clientRequestId: crypto.randomUUID() };
  assert.equal(store.submitDevFeedback(a.token, second, now + 86399999).status, 429);
  assert.equal(store.submitDevFeedback(a.token, second, now + 86400000).status, 201);
  assert.equal(store.submitDevFeedback(b.token, first, now).status, 409, "stale account A cannot submit through account B's cookie");
  assert.equal(store.getDevFeedbackAvailability(b.token, now).canSubmit, true);
  assert.equal(store.submitDevFeedback(b.token, { ...first, expectedOwnerPublicId: b.me.user.publicId }, now).status, 201);
});

test("feedback body limit allows full UTF8 messages without loosening other dev routes", () => {
  const headers = { origin: "http://localhost", "content-type": "application/json", "content-length": "10000" };
  const request = new Request("http://localhost/api/v1/feedback", { method: "POST", headers });
  assert.equal(guardDevApi(request, true)?.status, 413);
  assert.equal(guardDevApi(request, true, 16384), null);
  const crossSite = new Request("http://localhost/api/v1/feedback", { method: "POST", headers: { ...headers, origin: "https://other.test" } });
  assert.equal(guardDevApi(crossSite, true, 16384).status, 403);
});

test("admin feedback filters and status actions use the authenticated namespace", async () => {
  const item = { id: response.id, category: "suggestion", message: "Предлагаю новое улучшение", status: "new", createdAt: serverTime, updatedAt: serverTime, authorPublicId: publicId, authorDisplayName: "Player" };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/v1/admin/feedback?status=new&category=suggestion&offset=25&limit=25");
    assert.equal(options.credentials, "same-origin");
    return Response.json({ serverTime, total: 26, offset: 25, limit: 25, items: [item] });
  };
  assert.equal((await api.getAdminFeedback({ status: "new", category: "suggestion", offset: 25, limit: 25 })).items[0].message, item.message);
  globalThis.fetch = async (url, options) => {
    assert.equal(url, `/api/v1/admin/feedback/${item.id}/status`);
    assert.deepEqual(JSON.parse(options.body), { requestId: request.clientRequestId, status: "resolved" });
    return Response.json({ ...item, status: "resolved" });
  };
  assert.equal((await api.updateAdminFeedbackStatus(item.id, "resolved", request.clientRequestId)).status, "resolved");
  globalThis.fetch = async () => Response.json({ code: "FORBIDDEN", message: "Нет доступа" }, { status: 403 });
  await assert.rejects(api.getAdminFeedback({ status: "all", category: "all", offset: 0, limit: 25 }), error => error.status === 403);
});

test("reload guard retries a failed draft save and only permits reload once durable", async () => {
  const { readFile } = await import("node:fs/promises");
  const ts = await import("typescript");
  const vm = await import("node:vm");
  const source = await readFile(new URL("../features/feedback/feedback-dialog.tsx", import.meta.url), "utf8");
  const tree = ts.createSourceFile("feedback-dialog.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "preserveDraft") declaration = node.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(declaration);
  const disk = storage();
  const unsafeDraftRef = { current: true };
  const draft = { category: "bug", message: "Этот черновик надо сохранить", pending: request };
  const window = { get sessionStorage() { throw new Error("blocked"); } };
  const context = { unsafeDraftRef, draftRef: { current: draft }, ownerPublicId: publicId, window,
    writeFeedbackDraft: drafts.writeFeedbackDraft, setDraftSaved() {} };
  const js = ts.transpileModule(`const ${declaration}; preserveDraft;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const preserve = vm.runInNewContext(js, context);
  const blocked = new Event("zhiv:before-app-reload", { cancelable: true });
  preserve(blocked);
  assert.equal(blocked.defaultPrevented, true);
  Object.defineProperty(window, "sessionStorage", { value: disk });
  const recovered = new Event("zhiv:before-app-reload", { cancelable: true });
  preserve(recovered);
  assert.equal(recovered.defaultPrevented, false);
  assert.equal(unsafeDraftRef.current, false);
  assert.deepEqual(drafts.readFeedbackDraft(publicId, disk).pending, request);
});

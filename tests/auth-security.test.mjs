import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const cookieModule = "\0auth-security-cookies";
const originalMode = process.env.NODE_ENV;
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root, "next/headers": cookieModule } },
  server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "auth-security-cookies", resolveId(id) { if (id === cookieModule) return id; },
    load(id) { if (id === cookieModule) return "export async function cookies() { return { get() { return { value: globalThis.__authSecurityToken }; } }; }"; } }],
});
const social = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const notifications = await vite.ssrLoadModule("/lib/dev/notifications-store.ts");
const { defaultNotificationPreferences } = await vite.ssrLoadModule("/features/notifications/notification-contract.ts");
const { PeopleView } = await vite.ssrLoadModule("/features/people/people-view.tsx");
const routes = Object.fromEntries(await Promise.all([
  ["guest", "/app/api/v1/people/[circleId]/game-profile/route.ts"],
  ["nickname", "/app/api/v1/people/[circleId]/nickname/route.ts"],
  ["group", "/app/api/v1/groups/[groupId]/route.ts"],
  ["member", "/app/api/v1/groups/[groupId]/members/[membershipId]/route.ts"],
  ["invite", "/app/api/v1/groups/[groupId]/invites/route.ts"],
  ["accept", "/app/api/v1/group-invites/[inviteId]/accept/route.ts"],
  ["notifications", "/app/api/v1/notifications/route.ts"],
  ["preferences", "/app/api/v1/notifications/preferences/route.ts"],
].map(async ([name, path]) => [name, await vite.ssrLoadModule(path)])));

beforeEach(() => {
  process.env.NODE_ENV = "test";
  delete globalThis.__authSecurityToken;
  social.resetDevStoreForTests();
  notifications.resetDevNotificationsForTests();
});
after(async () => {
  delete globalThis.__authSecurityToken;
  if (originalMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalMode;
  await vite.close();
});

const key = () => crypto.randomUUID();
const player = name => social.createDevIdentity(name, key());
function ok(result) { assert.equal(result.kind, "ok"); return result.value; }
function connect(a, b) {
  const sent = ok(social.sendDevDirectRequest(a.token, b.me.user.publicId, key()));
  return ok(social.actOnDevDirectRequest(b.token, sent.request.requestId, "ACCEPTED")).person.circleId;
}
const context = params => ({ params: Promise.resolve(params) });
function request(path, method = "GET", body, headers = {}) {
  return new Request(`http://localhost${path}`, { method, headers: {
    Origin: "http://localhost", "Idempotency-Key": key(),
    ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function fixture() {
  const owner = player("Создатель"), member = player("Участник"), outsider = player("Посторонний"), pending = player("Приглашённый");
  const circleId = connect(owner, member), pendingCircleId = connect(owner, pending);
  const groupId = ok(social.createDevGroup(owner.token, "Семья", null, [circleId, pendingCircleId], key())).groupId;
  const memberInvite = ok(social.listDevGroups(member.token)).incomingInvites[0];
  ok(social.actOnDevGroupInvite(member.token, memberInvite.inviteId, "ACCEPTED"));
  const inviteId = ok(social.listDevGroups(pending.token)).incomingInvites[0].inviteId;
  const group = ok(social.listDevGroups(owner.token)).groups[0];
  const membershipId = group.members.find(item => item.user.publicId === member.me.user.publicId).membershipId;
  const ownerMembershipId = group.members.find(item => item.user.publicId === owner.me.user.publicId).membershipId;
  return { owner, member, outsider, pending, circleId, pendingCircleId, groupId, membershipId, ownerMembershipId, inviteId };
}
async function status(response, expected) {
  assert.equal(response.status, expected, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response;
}

test("HTTP group IDs and membership IDs do not give an outsider or ordinary member owner privileges", async () => {
  const f = fixture();
  for (const [actor, expected] of [[f.member, 403], [f.outsider, 404]]) {
    globalThis.__authSecurityToken = actor.token;
    await status(await routes.group.PATCH(request(`/api/v1/groups/${f.groupId}`, "PATCH", { title: "Подмена", emoji: null }), context(f)), expected);
    await status(await routes.group.DELETE(request(`/api/v1/groups/${f.groupId}`, "DELETE"), context(f)), expected);
    const target = { ...f, membershipId: f.ownerMembershipId };
    await status(await routes.member.DELETE(request(`/api/v1/groups/${f.groupId}/members/${target.membershipId}`, "DELETE"), context(target)), expected);
    await status(await routes.invite.POST(request(`/api/v1/groups/${f.groupId}/invites`, "POST", { personCircleId: f.pendingCircleId }), context(f)), expected);
  }
  const saved = ok(social.listDevGroups(f.owner.token)).groups[0];
  assert.equal(saved.title, "Семья");
  assert.equal(saved.members.length, 2);
  assert.equal(saved.pendingInvites.length, 1);
});

test("a member can leave their own group without gaining permission to remove its owner", async () => {
  const f = fixture();
  globalThis.__authSecurityToken = f.member.token;
  await status(await routes.member.DELETE(request(`/api/v1/groups/${f.groupId}/members/${f.membershipId}`, "DELETE"), context(f)), 204);
  assert.equal(ok(social.listDevGroups(f.member.token)).groups.length, 0);
  const saved = ok(social.listDevGroups(f.owner.token)).groups[0];
  assert.equal(saved.members.length, 1);
  assert.equal(saved.members[0].user.publicId, f.owner.me.user.publicId);
});

test("an invitation can only be accepted by its intended recipient, including through the HTTP route", async () => {
  const f = fixture();
  for (const actor of [f.owner, f.member, f.outsider]) {
    globalThis.__authSecurityToken = actor.token;
    await status(await routes.accept.POST(request(`/api/v1/group-invites/${f.inviteId}/accept`, "POST"), context(f)), 403);
  }
  assert.equal(ok(social.listDevGroups(f.pending.token)).incomingInvites.length, 1);
  globalThis.__authSecurityToken = f.pending.token;
  await status(await routes.accept.POST(request(`/api/v1/group-invites/${f.inviteId}/accept`, "POST"), context(f)), 200);
});

test("cross-site requests cannot rename, archive, invite, remove members or accept invitations", async () => {
  const f = fixture();
  const attacks = [
    () => routes.group.PATCH(request(`/api/v1/groups/${f.groupId}`, "PATCH", { title: "Подмена", emoji: null }, hostile), context(f)),
    () => routes.group.DELETE(request(`/api/v1/groups/${f.groupId}`, "DELETE", undefined, hostile), context(f)),
    () => routes.member.DELETE(request(`/api/v1/groups/${f.groupId}/members/${f.membershipId}`, "DELETE", undefined, hostile), context(f)),
    () => routes.invite.POST(request(`/api/v1/groups/${f.groupId}/invites`, "POST", { personCircleId: f.pendingCircleId }, hostile), context(f)),
    () => routes.accept.POST(request(`/api/v1/group-invites/${f.inviteId}/accept`, "POST", undefined, hostile), context(f)),
  ];
  let hostile;
  for (hostile of [{ Origin: "https://evil.example" }, { Origin: "null" }, { Origin: "http://localhost", "Sec-Fetch-Site": "cross-site" }]) {
    globalThis.__authSecurityToken = f.owner.token;
    for (const attack of attacks) await status(await attack(), 403);
  }
  assert.equal(ok(social.listDevGroups(f.owner.token)).groups[0].title, "Семья");
  assert.equal(ok(social.listDevGroups(f.owner.token)).groups[0].members.length, 2);
  assert.equal(ok(social.listDevGroups(f.pending.token)).incomingInvites.length, 1);
});

test("friend profile responses conceal stranger, removed and privacy-denied relationships identically", async () => {
  const f = fixture(), path = `/api/v1/people/${f.circleId}/game-profile`;
  globalThis.__authSecurityToken = f.owner.token;
  const visible = await status(await routes.guest.GET(request(path), context(f)), 200);
  const projection = await visible.json();
  assert.equal(projection.ownerPublicId, f.owner.me.user.publicId);
  assert.equal(projection.user.publicId, f.member.me.user.publicId);
  assert.deepEqual(Object.keys(projection).sort(), ["ownerPublicId", "circleId", "user", "homeLevel", "completedExplorations", "achievements", "collections", "serverTime"].sort());
  globalThis.__authSecurityToken = f.outsider.token;
  const outsider = await (await status(await routes.guest.GET(request(path), context(f)), 404)).json();
  globalThis.__authSecurityToken = f.owner.token;
  ok(social.updateDevSharing(f.member.token, f.circleId, "OFF"));
  const denied = await (await status(await routes.guest.GET(request(path), context(f)), 404)).json();
  ok(social.removeDevPerson(f.owner.token, f.circleId));
  const removed = await (await status(await routes.guest.GET(request(path), context(f)), 404)).json();
  assert.deepEqual(outsider, denied);
  assert.deepEqual(denied, removed);
});

test("a private nickname cannot be read or overwritten by another user through a known circle ID", async () => {
  const f = fixture(), path = `/api/v1/people/${f.circleId}/nickname`;
  globalThis.__authSecurityToken = f.owner.token;
  await status(await routes.nickname.PATCH(request(path, "PATCH", { nickname: "Личная подпись" }), context(f)), 200);
  assert.equal(ok(social.listDevPeople(f.member.token)).people.find(item => item.circleId === f.circleId).nickname, null);
  globalThis.__authSecurityToken = f.outsider.token;
  await status(await routes.nickname.PATCH(request(path, "PATCH", { nickname: "Подмена" }), context(f)), 403);
  assert.equal(ok(social.listDevPeople(f.owner.token)).people.find(item => item.circleId === f.circleId).nickname, "Личная подпись");
});

test("notification routes bind reads and writes to the current session owner and reject cross-site changes", async () => {
  const f = fixture(), preferences = { ...defaultNotificationPreferences(), constructionCompleted: false };
  globalThis.__authSecurityToken = f.owner.token;
  const own = { expectedOwnerPublicId: f.owner.me.user.publicId, preferences };
  await status(await routes.preferences.PUT(request("/api/v1/notifications/preferences", "PUT", own)), 200);
  await status(await routes.notifications.GET(request(`/api/v1/notifications?expectedOwnerPublicId=${f.member.me.user.publicId}`)), 409);
  await status(await routes.preferences.PUT(request("/api/v1/notifications/preferences", "PUT", { ...own, expectedOwnerPublicId: f.member.me.user.publicId })), 409);
  await status(await routes.preferences.PUT(request("/api/v1/notifications/preferences", "PUT", { ...own, preferences: defaultNotificationPreferences() }, { Origin: "https://evil.example" })), 403);
  assert.equal(notifications.getDevNotifications(f.owner.token, f.owner.me.user.publicId).value.preferences.constructionCompleted, false);
  assert.equal(notifications.getDevNotifications(f.member.token, f.member.me.user.publicId).value.preferences.constructionCompleted, true);
});

test("recovery revokes the former session across social and notification routes and cannot be replayed with a new retry secret", async () => {
  const f = fixture(), recoveryCode = "security-recovery-code", retrySecret = key();
  ok(social.activateDevRecoveryCode(f.owner.token, recoveryCode));
  const recovered = social.redeemDevRecoveryCode(recoveryCode, retrySecret);
  assert.equal(recovered.me.user.publicId, f.owner.me.user.publicId);
  assert.equal(social.redeemDevRecoveryCode(recoveryCode, key()), null);
  assert.equal(social.redeemDevRecoveryCode(recoveryCode, retrySecret).token, recovered.token);
  globalThis.__authSecurityToken = f.owner.token;
  await status(await routes.guest.GET(request(`/api/v1/people/${f.circleId}/game-profile`), context(f)), 401);
  await status(await routes.group.PATCH(request(`/api/v1/groups/${f.groupId}`, "PATCH", { title: "Подмена", emoji: null }), context(f)), 401);
  await status(await routes.notifications.GET(request(`/api/v1/notifications?expectedOwnerPublicId=${f.owner.me.user.publicId}`)), 401);
  globalThis.__authSecurityToken = recovered.token;
  await status(await routes.guest.GET(request(`/api/v1/people/${f.circleId}/game-profile`), context(f)), 200);
});

test("local social and notification API handlers stay disabled in production even with valid development sessions", async () => {
  const f = fixture();
  globalThis.__authSecurityToken = f.owner.token;
  process.env.NODE_ENV = "production";
  await status(await routes.guest.GET(request(`/api/v1/people/${f.circleId}/game-profile`), context(f)), 503);
  await status(await routes.group.DELETE(request(`/api/v1/groups/${f.groupId}`, "DELETE"), context(f)), 503);
  await status(await routes.notifications.GET(request(`/api/v1/notifications?expectedOwnerPublicId=${f.owner.me.user.publicId}`)), 503);
  await status(await routes.preferences.PUT(request("/api/v1/notifications/preferences", "PUT", { expectedOwnerPublicId: f.owner.me.user.publicId, preferences: defaultNotificationPreferences() })), 503);
  assert.equal(ok(social.listDevGroups(f.owner.token)).groups[0].title, "Семья");
});

test("real people UI escapes stored HTML in names, nicknames and statuses while preserving the text", () => {
  const owner = player("Владелец"), markup = '<img src=x onerror="alert(1)">', friend = player(markup), circleId = connect(owner, friend);
  ok(social.updateDevNickname(owner.token, circleId, "<script>alert(2)</script>"));
  ok(social.updateDevStatus(friend.token, "<svg onload=alert(3)>", key()));
  const html = renderToStaticMarkup(createElement(PeopleView, {
    ownerPublicId: owner.me.user.publicId, data: ok(social.listDevPeople(owner.token)), groups: null,
    error: null, groupsError: null, loading: false, groupsLoading: false, nowMs: Date.now(),
    onRefresh: async () => {}, onGroupsRefresh: async () => {}, onSessionLost() {},
  }));
  assert.ok(html.includes("&lt;script&gt;alert(2)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;svg onload=alert(3)&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
  assert.doesNotMatch(html, /<script\b|<img src=x|<svg onload=/);
});

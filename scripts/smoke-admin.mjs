import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Never create these privileged fixtures on a live deployment or a developer stack.
const root = fileURLToPath(new URL("../", import.meta.url));
assert.equal(process.env.CI, "true", "This smoke test requires isolated GitHub CI");
assert.equal(process.env.GITHUB_ACTIONS, "true", "This smoke test requires isolated GitHub CI");
assert.equal(process.env.DOMAIN, "localhost", "This smoke test only addresses localhost");
assert.match(process.env.COMPOSE_PROJECT_NAME ?? "", /^zhiv-ci-[0-9]+$/);
assert.equal(existsSync(resolve(root, "deploy/.env")), false, "A deployment .env must not be present");
assert.equal(process.env.ADMIN_PUBLIC_IDS, "0000-0000-0571,0000-0000-0572");
assert.equal(process.env.MONITORING_URL, "http://prometheus:9090");
assert.equal(process.env.METRICS_TOKEN_FILE, "/run/monitoring-secrets/token");
assert.ok((process.env.COMPOSE_PROFILES ?? "").split(",").includes("monitoring"));

const origin = "https://localhost";
const adminIds = process.env.ADMIN_PUBLIC_IDS.split(",");
const composeArgs = ["compose", "-f", "deploy/compose.yml"];
function docker(args, { input, expected = 0 } = {}) {
  const result = spawnSync("docker", [...composeArgs, ...args], {
    cwd: root, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], timeout: 15_000,
  });
  // SQL input, cookies, scrape credentials, and process stderr must never reach CI logs.
  assert.equal(result.status, expected, "Isolated admin fixture command failed");
  return result.stdout.trim();
}
function sql(statement) {
  return docker(["exec", "-T", "db", "psql", "-X", "-U", "zhiv", "-d", "zhiv", "-v", "ON_ERROR_STOP=1", "-qAt"], { input: statement });
}
async function api(method, path, { cookie, body, expected = 200, source = origin, headers: extraHeaders = {}, timeout = 10_000 } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const result = await new Promise((resolveResult, reject) => {
    const headers = { "Idempotency-Key": randomUUID(), ...extraHeaders };
    if (source !== null) headers.Origin = source;
    if (cookie) headers.Cookie = cookie;
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = request(new URL(path, origin), { method, headers, rejectUnauthorized: false, signal: AbortSignal.timeout(timeout) }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", () => reject(new Error("Isolated admin API response failed")));
      res.on("end", () => resolveResult({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", () => reject(new Error("Isolated admin API request failed")));
    req.end(payload);
  });
  assert.equal(result.status, expected, `${method} ${path} returned an unexpected status`);
  const data = result.text && result.headers["content-type"]?.includes("application/json") ? JSON.parse(result.text) : null;
  const cookieValue = result.headers["set-cookie"]?.[0]?.split(";")[0];
  return { ...result, data, cookie: cookieValue };
}
function secureSession() {
  const raw = randomBytes(32).toString("base64url");
  return { hash: createHash("sha256").update(raw).digest("hex"), cookie: `__Host-zhiv_session=${raw}` };
}
function addSession(publicId) {
  assert.match(publicId, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
  const session = secureSession();
  const changed = sql(`INSERT INTO app_sessions(user_id,token_hash,expires_at)
    SELECT id,decode('${session.hash}','hex'),clock_timestamp()+interval '1 day'
    FROM app_users WHERE public_id='${publicId}' AND deleted_at IS NULL RETURNING 1;`);
  assert.equal(changed, "1", "Expected one isolated authentication session");
  return session.cookie;
}
function seedAdmin(publicId, name, email) {
  assert.ok(adminIds.includes(publicId));
  // All interpolated values are fixed fixture constants or generated UUIDs/hashes.
  sql(`INSERT INTO app_users(id,public_id,display_name) VALUES ('${randomUUID()}','${publicId}','${name}');
    INSERT INTO account_login_identities(provider,subject,user_id)
    SELECT 'email','${email}',id FROM app_users WHERE public_id='${publicId}';`);
  return { publicId, cookie: addSession(publicId) };
}
async function profile(name) {
  const created = await api("POST", "/api/v1/bootstrap", { body: { displayName: name }, expected: 201 });
  assert.ok(created.cookie, "Fixture bootstrap did not return a protected session");
  return { publicId: created.data.user.publicId, cookie: created.cookie };
}

assert.equal(sql("SELECT has_table_privilege('zhiv_app','admin_actions','SELECT'), has_table_privilege('zhiv_app','admin_actions','INSERT'), has_table_privilege('zhiv_app','admin_actions','UPDATE'), has_table_privilege('zhiv_app','admin_actions','DELETE');"), "t|t|f|f", "Runtime audit permissions must be append-only");
assert.equal(sql("SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname='zhiv_app';"), "f|f|f|f", "Administrator API must not use a privileged database role");
const admin = seedAdmin(adminIds[0], "CI admin primary", "admin-primary@example.invalid");
const peer = seedAdmin(adminIds[1], "CI admin peer", "admin-peer@example.invalid");
const ordinary = await profile("CI admin ordinary");
const target = await profile("CI admin target");
const targetSecondCookie = addSession(target.publicId);
const adminPaths = ["access", "overview?days=7", "users", "audit", "monitoring"].map((path) => "/api/v1/admin/" + path);
for (const path of adminPaths) {
  const anonymous = await api("GET", path, { expected: 401, headers: { "X-Admin-Public-Id": admin.publicId, "X-Role": "admin" } });
  assert.equal(anonymous.headers["cache-control"], "no-store");
  const forbidden = await api("GET", path, { cookie: ordinary.cookie, expected: 403, headers: { "X-Admin-Public-Id": admin.publicId, "X-Role": "admin" } });
  assert.equal(forbidden.headers["cache-control"], "no-store");
}
const access = await api("GET", "/api/v1/admin/access", { cookie: admin.cookie });
assert.equal(access.data.publicId, admin.publicId);
assert.deepEqual(Object.keys(access.data).sort(), ["displayName", "publicId", "serverTime"]);
assert.equal(access.headers["cache-control"], "no-store");
assert.equal(access.headers["x-robots-tag"], "noindex, nofollow");
assert.equal((await api("GET", "/admin")).headers["cache-control"], "no-store");

// The edge never forwards scrape routes, even if the correct token is supplied.
const scrapeToken = readFileSync(resolve(root, "deploy/.secrets/monitoring/token"), "utf8").trim();
assert.ok(scrapeToken.length >= 32, "Isolated scrape credential must exist");
for (const path of ["/internal/metrics", "/metrics", "/api/v1/query?query=up"]) await api("GET", path, { expected: 404 });
await api("GET", "/internal/metrics", { expected: 404, headers: { Authorization: `Bearer ${scrapeToken}` } });
assert.equal(docker(["exec", "-T", "api", "curl", "--silent", "--max-time", "3", "--output", "/dev/null", "--write-out", "%{http_code}", "http://127.0.0.1:8080/internal/metrics"]), "404");
// Inspect only port bindings, never container environment variables containing credentials.
for (const service of ["prometheus", "node-exporter"]) {
  const id = docker(["ps", "--quiet", service]);
  const inspected = spawnSync("docker", ["inspect", "--format", "{{json .HostConfig.PortBindings}}", id], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(inspected.status, 0, "Could not inspect internal monitoring port bindings");
  assert.equal(Object.keys(JSON.parse(inspected.stdout) ?? {}).length, 0, "Monitoring services must not publish host ports");
}

const marked = await api("POST", "/api/v1/check-ins", { cookie: target.cookie });
assert.ok(marked.data.checkedAt);
const session = await api("POST", "/api/v1/game/sessions", { cookie: target.cookie, body: { ownerPublicId: target.publicId, requestId: randomUUID() } });
const scored = await api("POST", "/api/v1/game/batches", { cookie: target.cookie, body: { sessionId: session.data.sessionId, sequence: 1, tapCount: 9, runId: randomUUID() } });
assert.equal(scored.data.acceptedTaps, 9);
const overview = await api("GET", "/api/v1/admin/overview?days=7", { cookie: admin.cookie });
assert.equal(overview.data.days, 7);
assert.equal(overview.data.daily.length, 7);
assert.ok(overview.data.totals.users >= 4);
assert.ok(overview.data.totals.checkIns >= 1);
assert.ok(overview.data.game.taps >= 9);
assert.ok(overview.data.game.bestSeries >= 9);
assert.equal(overview.data.daily.reduce((sum, day) => sum + day.checkIns, 0), overview.data.checkInsPeriod);
assert.equal(overview.data.daily.reduce((sum, day) => sum + day.registrations, 0), overview.data.newUsersPeriod);
assert.equal(overview.data.services.databaseReady, true);
assert.ok(overview.data.services.databaseBytes > 0);
assert.ok(overview.data.services.databaseConnections > 0);
assert.ok(overview.data.services.activeSessions >= 5);
assert.equal(overview.headers["cache-control"], "no-store");
const users = await api("GET", "/api/v1/admin/users?q=CI%20admin&sort=taps&offset=0&limit=2", { cookie: admin.cookie });
assert.equal(users.data.total, 4);
assert.equal(users.data.users.length, 2);
assert.equal(users.data.users[0].publicId, target.publicId);
assert.equal(users.data.users[0].bestSeries, 9);
assert.equal(users.data.users[0].checkInCount, 1);
assert.equal(users.data.users[0].activeSessions, 2);
const secondPage = await api("GET", "/api/v1/admin/users?q=CI%20admin&sort=taps&offset=2&limit=2", { cookie: admin.cookie });
assert.equal(new Set([...users.data.users, ...secondPage.data.users].map((user) => user.publicId)).size, 4);
const adminRow = (await api("GET", "/api/v1/admin/users?q=" + admin.publicId, { cookie: admin.cookie })).data.users[0];
assert.equal(adminRow.isAdmin, true);
assert.deepEqual(adminRow.loginMethods, ["email"]);
assert.deepEqual(Object.keys(adminRow).sort(), ["activeSessions", "bannedAt", "bestSeries", "checkInCount", "createdAt", "displayName", "friendCount", "isAdmin", "lastCheckInAt", "leaderboardOptIn", "lifetimeTaps", "loginMethods", "monthlyTaps", "publicId", "tag", "tapSignalAt", "watchlisted"]);
assert.equal(adminRow.tag, null);
assert.equal(adminRow.bannedAt, null);
assert.equal(adminRow.tapSignalAt, null);
assert.equal(adminRow.watchlisted, false);
assert.equal(JSON.stringify(adminRow).includes("admin-primary@example.invalid"), false);
assert.equal((await api("GET", "/api/v1/admin/users?q=%25_", { cookie: admin.cookie })).data.total, 0);
await api("GET", "/api/v1/admin/users?limit=101", { cookie: admin.cookie, expected: 400 });
await api("GET", "/api/v1/admin/overview?days=7&days=30", { cookie: admin.cookie, expected: 400 });

const path = "/api/v1/admin/users/" + target.publicId + "/revoke-sessions";
const body = { requestId: randomUUID(), confirmationPublicId: target.publicId, reason: "CI security session revocation" };
await api("POST", path, { body, expected: 401 });
await api("POST", path, { cookie: ordinary.cookie, body, expected: 403 });
for (const source of [null, "https://untrusted.invalid"]) await api("POST", path, { cookie: admin.cookie, body, source, expected: 403 });
await api("POST", path, { cookie: admin.cookie, body: { ...body, confirmationPublicId: ordinary.publicId }, expected: 400 });
for (const protectedId of [admin.publicId, peer.publicId]) {
  await api("POST", "/api/v1/admin/users/" + protectedId + "/revoke-sessions", { cookie: admin.cookie, body: { ...body, requestId: randomUUID(), confirmationPublicId: protectedId }, expected: 409 });
}
await api("GET", "/api/v1/me", { cookie: target.cookie });
const auditBefore = await api("GET", "/api/v1/admin/audit", { cookie: admin.cookie });
assert.equal(auditBefore.data.total, 0);
const revoked = await api("POST", path, { cookie: admin.cookie, body });
assert.equal(revoked.data.requestId, body.requestId);
assert.equal(revoked.data.affectedSessions, 2);
assert.equal(revoked.headers["cache-control"], "no-store");
await api("GET", "/api/v1/me", { cookie: target.cookie, expected: 401 });
await api("GET", "/api/v1/me", { cookie: targetSecondCookie, expected: 401 });
const freshCookie = addSession(target.publicId);
const replay = await api("POST", path, { cookie: admin.cookie, body });
assert.deepEqual(replay.data, revoked.data);
await api("GET", "/api/v1/me", { cookie: freshCookie });
await api("POST", path, { cookie: admin.cookie, body: { ...body, reason: "CI conflicting retry reason" }, expected: 409 });
await api("POST", path, { cookie: peer.cookie, body, expected: 409 });
const audit = await api("GET", "/api/v1/admin/audit?offset=0&limit=1", { cookie: admin.cookie });
assert.equal(audit.data.total, 1);
assert.equal(audit.data.events.length, 1);
assert.equal(audit.data.events[0].requestId, body.requestId);
assert.equal(audit.data.events[0].actorPublicId, admin.publicId);
assert.equal(audit.data.events[0].targetPublicId, target.publicId);
assert.equal(audit.data.events[0].affectedSessions, 2);
assert.equal(audit.data.events[0].action, "revoke_sessions");
assert.equal((await api("GET", "/api/v1/admin/audit?offset=1&limit=1", { cookie: admin.cookie })).data.events.length, 0);

const grantPath = `/api/v1/admin/users/${target.publicId}/grant-reward`;
const grantBody = { requestId: randomUUID(), confirmationPublicId: target.publicId, kind: "item", rewardId: "leaf_garland", reason: "CI isolated reward validation" };
await api("POST", grantPath, { cookie: ordinary.cookie, body: grantBody, expected: 403 });
const granted = await api("POST", grantPath, { cookie: admin.cookie, body: grantBody });
assert.equal(granted.data.granted, true);
assert.deepEqual((await api("POST", grantPath, { cookie: admin.cookie, body: grantBody })).data, granted.data);
assert.deepEqual((await api("GET", "/api/v1/game/progress", { cookie: freshCookie })).data.items, ["leaf_garland"]);
assert.deepEqual((await api("GET", `/api/v1/admin/users/${target.publicId}/rewards`, { cookie: admin.cookie })).data.items, ["leaf_garland"]);
await api("POST", path, { cookie: admin.cookie, body: { requestId: grantBody.requestId, confirmationPublicId: target.publicId, reason: grantBody.reason }, expected: 409 });
const achievementGrant = { ...grantBody, requestId: randomUUID(), kind: "achievement", rewardId: "ten_thousand_series" };
await api("POST", grantPath, { cookie: admin.cookie, body: achievementGrant });
assert.equal((await api("GET", "/api/v1/game/achievements?catalog=3", { cookie: freshCookie })).data.achievements.find(item => item.id === "ten_thousand_series").progress, 10000);
assert.equal((await api("GET", "/api/v1/admin/audit", { cookie: admin.cookie })).data.total, 3);

// Exercise moderation through HTTPS using the restricted production database role.
const playerPath = `/api/v1/admin/users/${target.publicId}/player`;
const managePath = `/api/v1/admin/users/${target.publicId}/manage`;
const clicksPath = `/api/v1/admin/users/${target.publicId}/tap-activity`;
const historyPath = `/api/v1/admin/users/${target.publicId}/tap-history`;
for (const privatePath of [playerPath, clicksPath, historyPath]) {
  await api("GET", privatePath, { expected: 401 });
  await api("GET", privatePath, { cookie: ordinary.cookie, expected: 403 });
}
const beforeManagement = await api("GET", playerPath, { cookie: admin.cookie });
const management = (action, extra = {}) => ({ requestId: randomUUID(), confirmationPublicId: target.publicId,
  reason: "CI isolated moderation validation", action, ...extra });
const resourceGrant = management("grant_resource", { target: "wood", amount: 25 });
await api("POST", managePath, { cookie: ordinary.cookie, body: resourceGrant, expected: 403 });
await api("POST", managePath, { cookie: admin.cookie, body: resourceGrant, source: "https://untrusted.invalid", expected: 403 });
const resourceReceipt = await api("POST", managePath, { cookie: admin.cookie, body: resourceGrant });
assert.equal(resourceReceipt.data.changed, true);
assert.deepEqual((await api("POST", managePath, { cookie: admin.cookie, body: resourceGrant })).data, resourceReceipt.data);
assert.equal((await api("GET", "/api/v1/world", { cookie: freshCookie })).data.state.resources.wood,
  beforeManagement.data.world.resources.wood + 25);
const tag = { text: "Tester", color: "blue" };
await api("POST", managePath, { cookie: admin.cookie, body: management("set_tag", { tag }) });
assert.deepEqual((await api("GET", "/api/v1/me", { cookie: freshCookie })).data.user.tag, tag);
const clicks = await api("GET", clicksPath, { cookie: admin.cookie });
assert.equal(clicks.headers["cache-control"], "no-store");
assert.deepEqual(clicks.data.windows.map(window => window.seconds), [10, 30, 60, 1800]);
assert.equal(clicks.data.analysis.status, "insufficient_data");
assert.equal(sql(`SELECT sum(received_taps) FROM game_tap_activity_seconds WHERE user_id=(SELECT id FROM app_users WHERE public_id='${target.publicId}');`), "9");
const history = await api("GET", historyPath, { cookie: admin.cookie });
assert.equal(history.headers["cache-control"], "no-store");
assert.equal(history.data.publicId, target.publicId);
assert.equal(history.data.minutes.reduce((sum, minute) => sum + minute.receivedTaps, 0), 9);
assert.ok(history.data.minutes.every(minute => Number.isSafeInteger(minute.receivedTaps)
  && typeof minute.complete === "boolean" && typeof minute.watchlisted === "boolean"));
assert.deepEqual((await api("GET", historyPath, { cookie: admin.cookie })).data.minutes.map(row => [row.at, row.receivedTaps]),
  history.data.minutes.map(row => [row.at, row.receivedTaps]));
const ban = management("ban");
const banned = await api("POST", managePath, { cookie: admin.cookie, body: ban });
assert.equal(banned.data.changed, true);
await api("GET", "/api/v1/me", { cookie: freshCookie, expected: 401 });
assert.ok((await api("GET", playerPath, { cookie: admin.cookie })).data.bannedAt);
await api("POST", managePath, { cookie: admin.cookie, body: management("unban") });
assert.deepEqual((await api("POST", managePath, { cookie: admin.cookie, body: ban })).data, banned.data);
assert.equal((await api("GET", playerPath, { cookie: admin.cookie })).data.bannedAt, null);
await api("GET", "/api/v1/me", { cookie: freshCookie, expected: 401 });
const unbannedCookie = addSession(target.publicId);
assert.deepEqual((await api("GET", "/api/v1/me", { cookie: unbannedCookie })).data.user.tag, tag);
assert.equal((await api("GET", "/api/v1/game/progress", { cookie: unbannedCookie })).data.lifetimeTaps, 9);
assert.equal((await api("GET", "/api/v1/admin/audit", { cookie: admin.cookie })).data.total, 7);
await api("POST", managePath, { cookie: admin.cookie, body: management("watch") });
assert.equal((await api("GET", playerPath, { cookie: admin.cookie })).data.watchlisted, true);
await api("POST", managePath, { cookie: admin.cookie, body: management("unwatch") });
assert.equal((await api("GET", playerPath, { cookie: admin.cookie })).data.watchlisted, false);

// Two 15-second scrapes are required for rate(). The API cache lasts 10 seconds.
// Keep a hard wall-clock deadline and print only the readiness result, not raw metrics.
const deadline = performance.now() + 60_000;
let monitoringReady = false;
while (performance.now() < deadline) {
  const remaining = Math.max(1, Math.min(5_000, Math.floor(deadline - performance.now())));
  const monitoring = await api("GET", "/api/v1/admin/monitoring", { cookie: admin.cookie, timeout: remaining });
  assert.equal(monitoring.headers["cache-control"], "no-store");
  assert.equal(monitoring.data.configured, true);
  const summary = monitoring.data.summary;
  const healthy = (name) => monitoring.data.health.some((service) => service.name === name && service.status === "up");
  const finite = (name) => typeof summary[name] === "number" && Number.isFinite(summary[name]);
  if (monitoring.data.available && healthy("prometheus") && healthy("api") && healthy("node") &&
      finite("cpuPercent") && finite("memoryUsedBytes") && finite("memoryTotalBytes") &&
      finite("diskUsedBytes") && finite("diskTotalBytes") && finite("apiUptimeSeconds") && finite("jvmHeapUsedBytes")) {
    assert.ok(summary.cpuPercent >= 0 && summary.cpuPercent <= 100);
    assert.ok(summary.memoryTotalBytes > 0 && summary.memoryUsedBytes >= 0 && summary.memoryUsedBytes <= summary.memoryTotalBytes);
    assert.ok(summary.diskTotalBytes > 0 && summary.diskUsedBytes >= 0 && summary.diskUsedBytes <= summary.diskTotalBytes);
    assert.ok(summary.apiUptimeSeconds > 0 && summary.jvmHeapUsedBytes > 0);
    assert.equal(monitoring.data.rangeMinutes, 60);
    assert.ok(Array.isArray(monitoring.data.samples) && Array.isArray(monitoring.data.alerts));
    monitoringReady = true;
    break;
  }
  await delay(Math.max(0, Math.min(2_000, deadline - performance.now())));
}
assert.ok(monitoringReady, "Real API/node scrapes and CPU, memory, disk values must appear within 60 seconds");
console.log("Admin production smoke passed: authorization, restricted SQL grants, tags, bans, tap telemetry, idempotent audit, internal metrics and real host monitoring.");

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
const presenceByCookie = new Map();
async function resumePresence(cookie) {
  const presenceId = randomUUID();
  const result = await api("POST", "/api/v1/presence", { cookie, body: { kind: "resume", presenceId, sequence: 0, active: true } });
  assert.equal(result.data.status, "active");
  presenceByCookie.set(cookie, presenceId);
  return presenceId;
}
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
    if (presenceByCookie.has(cookie)) headers["X-Game-Presence"] = presenceByCookie.get(cookie);
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
await resumePresence(target.cookie);
await resumePresence(targetSecondCookie);
const adminPaths = ["access", "overview?days=7", "users", "economy", "analytics", "analytics/events", "audit", "monitoring"].map((path) => "/api/v1/admin/" + path);
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

const analytics = await api("GET", `/api/v1/admin/analytics?q=${target.publicId}`, { cookie: admin.cookie });
assert.equal(analytics.data.q, target.publicId);
assert.equal(analytics.data.scope, "players");
assert.equal(analytics.data.coverage.matchingPlayers, 1);
assert.equal(analytics.data.summary.events, 0);
assert.equal(analytics.headers["cache-control"], "no-store");
assert.equal(analytics.headers["x-robots-tag"], "noindex, nofollow");
const operations = await api("GET", `/api/v1/admin/analytics/events?q=${target.publicId}&limit=25`, { cookie: admin.cookie });
assert.equal(operations.data.total, 0);
assert.deepEqual(operations.data.events, []);
await api("GET", "/api/v1/admin/analytics?scope=players&scope=all", { cookie: admin.cookie, expected: 400 });
await api("GET", "/api/v1/admin/analytics/events?limit=101", { cookie: admin.cookie, expected: 400 });

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
assert.deepEqual(Object.keys(adminRow).sort(), ["activeSessions", "bannedAt", "bestSeries", "checkInCount", "createdAt", "displayName", "friendCount", "isAdmin", "lastCheckInAt", "leaderboardOptIn", "lifetimeTaps", "loginMethods", "monthlyTaps", "publicId", "securitySignalAt", "tag", "tapSignalAt", "watchlisted"]);
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
const securityPath = `/api/v1/admin/users/${target.publicId}/security`;
for (const privatePath of [playerPath, clicksPath, historyPath, securityPath]) {
  await api("GET", privatePath, { expected: 401 });
  await api("GET", privatePath, { cookie: ordinary.cookie, expected: 403 });
}
const beforeManagement = await api("GET", playerPath, { cookie: admin.cookie });
const management = (action, extra = {}) => ({ requestId: randomUUID(), confirmationPublicId: target.publicId,
  reason: "CI isolated moderation validation", action, ...extra });
const resourceGrant = management("grant_resource", { target: "wood", amount: 25 });
await api("POST", managePath, { cookie: ordinary.cookie, body: resourceGrant, expected: 403 });
await api("POST", managePath, { cookie: admin.cookie, body: resourceGrant, source: "https://untrusted.invalid", expected: 403 });
const resourceDenied = await api("POST", managePath, { cookie: admin.cookie, body: resourceGrant, expected: 409 });
assert.equal(resourceDenied.data.code, "ADMIN_RESOURCE_RETIRED");
assert.equal((await api("GET", "/api/v1/admin/audit", { cookie: admin.cookie })).data.total, 3, "Rejected legacy grants must not create a successful audit action");
assert.equal((await api("GET", "/api/v1/world", { cookie: freshCookie })).data.state.resources.wood,
  beforeManagement.data.world.resources.wood);
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
assert.equal((await api("GET", "/api/v1/admin/audit", { cookie: admin.cookie })).data.total, 6);
await api("POST", managePath, { cookie: admin.cookie, body: management("watch") });
assert.equal((await api("GET", playerPath, { cookie: admin.cookie })).data.watchlisted, true);
await api("POST", managePath, { cookie: admin.cookie, body: management("unwatch") });
assert.equal((await api("GET", playerPath, { cookie: admin.cookie })).data.watchlisted, false);

// Confirm actual denied-command recording through HTTPS and the restricted SQL role.
const securityInitial = await api("GET", securityPath, { cookie: admin.cookie });
assert.equal(securityInitial.data.publicId, target.publicId);
assert.equal(securityInitial.headers["cache-control"], "no-store");
assert.deepEqual(securityInitial.data.signals, []);
await resumePresence(unbannedCookie);
const economyBefore = (await api("GET", "/api/v1/economy", { cookie: unbannedCookie })).data;
const sale = { requestId: randomUUID(), ownerPublicId: target.publicId, expectedRevision: economyBefore.revision,
  action: "sell", targetId: "wood", quantity: 1 };
const acceptedSale = await api("POST", "/api/v1/economy/commands", { cookie: unbannedCookie, body: sale });
assert.equal((await api("POST", "/api/v1/economy/commands", { cookie: unbannedCookie, body: sale })).data.replayed, true);
assert.deepEqual((await api("GET", securityPath, { cookie: admin.cookie })).data.signals, []);
const changedSale = { ...sale, quantity: 2 };
for (let attempt = 0; attempt < 2; attempt++)
  assert.equal((await api("POST", "/api/v1/economy/commands", { cookie: unbannedCookie, body: changedSale, expected: 409 })).data.code, "ECONOMY_REQUEST_CONFLICT");
const observation = (await api("GET", securityPath, { cookie: admin.cookie })).data.signals.find(signal => signal.code === "ECONOMY_REQUEST_TAMPER");
assert.equal(observation.count, 1);
assert.equal(observation.status, "active");
assert.equal(observation.lastRequestId, sale.requestId);
assert.ok(observation.reason.length > 0);
const unchangedEconomy = (await api("GET", "/api/v1/economy", { cookie: unbannedCookie })).data;
assert.deepEqual(unchangedEconomy.wallet, acceptedSale.data.state.wallet);
assert.equal(unchangedEconomy.revision, acceptedSale.data.state.revision);
await api("POST", managePath, { cookie: admin.cookie, body: management("clear_signal") });
const reviewedSecurity = (await api("GET", securityPath, { cookie: admin.cookie })).data;
assert.equal(reviewedSecurity.securitySignalAt, null);
assert.equal(reviewedSecurity.signals.find(signal => signal.code === "ECONOMY_REQUEST_TAMPER").status, "reviewed");

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

// Keep these additional mutations after the original exact audit/user counts.
// A fresh fixture and the peer administrator's separate write budget prevent
// earlier moderation checks or their per-account rate limit from being changed.
const mailTarget = await profile("CI isolated mail recipient");
assert.match(mailTarget.publicId, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
await resumePresence(mailTarget.cookie);
const mailGrantPath = `/api/v1/admin/users/${mailTarget.publicId}/grant-economy`;
const adjustmentPath = `/api/v1/admin/users/${mailTarget.publicId}/adjust-economy`;
const mailboxPath = `/api/v1/mail?expectedOwnerPublicId=${mailTarget.publicId}&limit=50`;
async function fixtureInbox() {
  const response = await api("GET", mailboxPath, { cookie: mailTarget.cookie });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-robots-tag"], "noindex, nofollow");
  assert.equal(response.data.ownerPublicId, mailTarget.publicId);
  assert.equal(response.data.nextCursor, null);
  return response.data;
}
function mailSourceCount(sourceKey) {
  assert.match(sourceKey, /^(?:admin|broadcast):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return Number(sql(`SELECT count(*) FROM player_mail_messages WHERE user_id=(SELECT id FROM app_users WHERE public_id='${mailTarget.publicId}') AND source_key='${sourceKey}';`));
}
function ledgerSourceCount(requestId) {
  assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return Number(sql(`SELECT count(*) FROM economy_ledger WHERE user_id=(SELECT id FROM app_users WHERE public_id='${mailTarget.publicId}') AND source_key='admin:${requestId}';`));
}
const initialMailEconomy = (await api("GET", "/api/v1/economy", { cookie: mailTarget.cookie })).data;
// A first inbox read delivers the fixed welcome gift, but never collects it.
// Read that one baseline letter so subsequent unread counts isolate admin mail.
const welcomeInbox = await fixtureInbox();
assert.equal(welcomeInbox.messages.length, 1);
assert.equal(welcomeInbox.unreadCount, 1);
const welcomeLetter = welcomeInbox.messages[0];
assert.equal(welcomeLetter.type, "event");
assert.equal(welcomeLetter.notify, false);
assert.equal(welcomeLetter.attachments, null);
assert.deepEqual(welcomeLetter.gift, { pearls: 100, claimedAt: null });
const welcomeRead = await api("POST", `/api/v1/mail/${welcomeLetter.id}/read`, { cookie: mailTarget.cookie,
  body: { expectedOwnerPublicId: mailTarget.publicId } });
assert.equal(welcomeRead.data.unreadCount, 0);
assert.ok(welcomeRead.data.readAt);
const welcomeAfterRead = await fixtureInbox();
assert.deepEqual(welcomeAfterRead.messages.map(message => message.id), [welcomeLetter.id]);
assert.equal(welcomeAfterRead.messages[0].readAt, welcomeRead.data.readAt);
assert.deepEqual(welcomeAfterRead.messages[0].gift, welcomeLetter.gift);
const economyAfterWelcome = (await api("GET", "/api/v1/economy", { cookie: mailTarget.cookie })).data;
assert.deepEqual(economyAfterWelcome.wallet, initialMailEconomy.wallet, "Welcome delivery and reading never collect the gift");
assert.equal(economyAfterWelcome.revision, initialMailEconomy.revision);
await api("GET", mailboxPath, { expected: 401 });
await api("GET", mailboxPath, { cookie: ordinary.cookie, expected: 409 });

const silentGrant = { requestId: randomUUID(), confirmationPublicId: mailTarget.publicId,
  reason: "CI private quiet grant reason", coins: 11, delivery: "silent" };
await api("POST", mailGrantPath, { cookie: ordinary.cookie, body: silentGrant, expected: 403 });
await api("POST", mailGrantPath, { cookie: peer.cookie, body: silentGrant, source: "https://untrusted.invalid", expected: 403 });
const silentReceipt = await api("POST", mailGrantPath, { cookie: peer.cookie, body: silentGrant });
assert.equal(silentReceipt.data.changed, true);
assert.equal(silentReceipt.headers["cache-control"], "no-store");
const afterSilent = (await api("GET", "/api/v1/economy", { cookie: mailTarget.cookie })).data;
assert.equal(afterSilent.wallet.coins, initialMailEconomy.wallet.coins + 11);
assert.equal(afterSilent.wallet.pearls, initialMailEconomy.wallet.pearls);
assert.deepEqual((await fixtureInbox()).messages.map(message => message.id), [welcomeLetter.id]);
assert.equal(mailSourceCount(`admin:${silentGrant.requestId}`), 0);

const privateGrantReason = "CI private notified grant audit reason";
const notifiedGrant = { requestId: randomUUID(), confirmationPublicId: mailTarget.publicId,
  reason: privateGrantReason, coins: 23, pearls: 3, delivery: "notify",
  playerMessage: { title: "Подарок для тестового игрока", body: "Начисление уже применено к вашему хозяйству." } };
const notifiedReceipt = await api("POST", mailGrantPath, { cookie: peer.cookie, body: notifiedGrant });
assert.deepEqual((await api("POST", mailGrantPath, { cookie: peer.cookie, body: notifiedGrant })).data, notifiedReceipt.data);
const afterNotified = (await api("GET", "/api/v1/economy", { cookie: mailTarget.cookie })).data;
assert.equal(afterNotified.wallet.coins, afterSilent.wallet.coins + 23);
assert.equal(afterNotified.wallet.pearls, afterSilent.wallet.pearls + 6, "Three visible pearls store exactly six units once");
assert.equal(afterNotified.revision, notifiedReceipt.data.acceptedRevision);
const grantInbox = await fixtureInbox();
assert.equal(grantInbox.messages.length, 2);
assert.equal(grantInbox.unreadCount, 1);
const grantLetter = grantInbox.messages.find(message => message.type === "admin_grant");
assert.ok(grantLetter);
assert.match(grantLetter.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
assert.equal(grantLetter.type, "admin_grant");
assert.equal(grantLetter.notify, true);
assert.equal(grantLetter.title, notifiedGrant.playerMessage.title);
assert.equal(grantLetter.body, notifiedGrant.playerMessage.body);
assert.equal(grantLetter.attachments.coins, 23);
assert.equal(grantLetter.attachments.pearls, 3);
assert.equal(JSON.stringify(grantInbox).includes(privateGrantReason), false);
assert.equal(mailSourceCount(`admin:${notifiedGrant.requestId}`), 1);
assert.equal(ledgerSourceCount(notifiedGrant.requestId), 1);
const letterReadPath = `/api/v1/mail/${grantLetter.id}/read`;
const readBody = { expectedOwnerPublicId: mailTarget.publicId };
await api("POST", letterReadPath, { cookie: ordinary.cookie, body: { expectedOwnerPublicId: ordinary.publicId }, expected: 404 });
await api("POST", letterReadPath, { cookie: mailTarget.cookie, body: readBody, source: "https://untrusted.invalid", expected: 403 });
const readReceipt = await api("POST", letterReadPath, { cookie: mailTarget.cookie, body: readBody });
assert.equal(readReceipt.headers["cache-control"], "no-store");
assert.equal(readReceipt.data.ownerPublicId, mailTarget.publicId);
assert.equal(readReceipt.data.id, grantLetter.id);
assert.equal(readReceipt.data.unreadCount, 0);
assert.ok(readReceipt.data.readAt);
const readReplay = await api("POST", letterReadPath, { cookie: mailTarget.cookie, body: readBody });
assert.equal(readReplay.data.readAt, readReceipt.data.readAt);
const afterRead = (await api("GET", "/api/v1/economy", { cookie: mailTarget.cookie })).data;
assert.deepEqual(afterRead.wallet, afterNotified.wallet, "Reading a letter cannot claim its attached receipt a second time");
assert.equal(afterRead.revision, afterNotified.revision);

const privateAdjustmentReason = "CI private signed correction audit reason";
const adjustment = { requestId: randomUUID(), confirmationPublicId: mailTarget.publicId,
  reason: privateAdjustmentReason, expectedRevision: afterRead.revision, coinsDelta: -7, pearlsDelta: -1, delivery: "notify",
  playerMessage: { title: "Поправка тестового кошелька", body: "Поправка уже отражена в кошельке." } };
await api("POST", adjustmentPath, { cookie: peer.cookie,
  body: { ...adjustment, requestId: randomUUID(), expectedRevision: afterRead.revision - 1 }, expected: 409 });
const adjustedReceipt = await api("POST", adjustmentPath, { cookie: peer.cookie, body: adjustment });
assert.deepEqual((await api("POST", adjustmentPath, { cookie: peer.cookie, body: adjustment })).data, adjustedReceipt.data);
const afterAdjustment = (await api("GET", "/api/v1/economy", { cookie: mailTarget.cookie })).data;
assert.equal(afterAdjustment.wallet.coins, afterRead.wallet.coins - 7);
assert.equal(afterAdjustment.wallet.pearls, afterRead.wallet.pearls - 2);
assert.equal(afterAdjustment.revision, adjustedReceipt.data.acceptedRevision);
const correctionInbox = await fixtureInbox();
assert.equal(correctionInbox.messages.length, 3);
const correctionLetter = correctionInbox.messages.find(message => message.type === "balance_correction");
assert.equal(correctionLetter.attachments.coins, -7);
assert.equal(correctionLetter.attachments.pearls, -1);
assert.equal(correctionLetter.body, adjustment.playerMessage.body);
assert.equal(JSON.stringify(correctionInbox).includes(privateAdjustmentReason), false);
assert.equal(mailSourceCount(`admin:${adjustment.requestId}`), 1);
assert.equal(ledgerSourceCount(adjustment.requestId), 1);

// No all-player broadcast: the selected audience is this one new CI fixture.
const broadcast = { requestId: randomUUID(), reason: "CI private targeted broadcast audit reason",
  title: "Изолированное объявление команды", body: "Письмо только одному тестовому получателю.",
  audience: "players", publicIds: [mailTarget.publicId], notify: true, confirmation: "ОТПРАВИТЬ" };
const broadcastPath = "/api/v1/admin/mail/broadcast";
await api("POST", broadcastPath, { body: broadcast, expected: 401 });
await api("POST", broadcastPath, { cookie: ordinary.cookie, body: broadcast, expected: 403 });
await api("POST", broadcastPath, { cookie: peer.cookie, body: broadcast, source: "https://untrusted.invalid", expected: 403 });
const broadcastReceipt = await api("POST", broadcastPath, { cookie: peer.cookie, body: broadcast });
assert.equal(broadcastReceipt.headers["cache-control"], "no-store");
assert.equal(broadcastReceipt.data.requestId, broadcast.requestId);
assert.equal(broadcastReceipt.data.recipientCount, 1);
assert.equal(broadcastReceipt.data.changed, true);
assert.deepEqual((await api("POST", broadcastPath, { cookie: peer.cookie, body: broadcast })).data, broadcastReceipt.data);
const finalInbox = await fixtureInbox();
assert.equal(finalInbox.messages.length, 4);
assert.equal(new Set(finalInbox.messages.map(message => message.id)).size, 4);
assert.equal(finalInbox.unreadCount, 2);
const broadcastLetter = finalInbox.messages.find(message => message.title === broadcast.title);
assert.equal(broadcastLetter.type, "admin_notice");
assert.equal(broadcastLetter.body, broadcast.body);
assert.equal(broadcastLetter.notify, true);
assert.equal(JSON.stringify(finalInbox).includes(broadcast.reason), false);
assert.equal(mailSourceCount(`broadcast:${broadcast.requestId}`), 1);
assert.equal(sql(`SELECT count(*) FROM notification_subscriptions WHERE user_id=(SELECT id FROM app_users WHERE public_id='${mailTarget.publicId}');`), "0", "Mail creation cannot create device consent or external push capability");

console.log("Admin production smoke passed: authorization, restricted SQL grants, tags, bans, tap telemetry, security observation recording and review, idempotent audit, private mail, silent/notified grants, signed wallet corrections, targeted broadcasts, internal metrics and real host monitoring.");

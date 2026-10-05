import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Starts an isolated local memory API. Never accepts a remote/production URL.
const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.PLAYER_SMOKE_PORT ?? 3217);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, "Invalid local test port");
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: root, env: { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "", cookie = "", checked = 0;
for (const stream of [server.stdout, server.stderr]) stream.on("data", data => { serverLog = (serverLog + data).slice(-12_000); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = async (path, { method = "GET", body, expected = 200, key = crypto.randomUUID(), useCookie = true } = {}) => {
  const response = await fetch(`${origin}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/json", Origin: origin, "Idempotency-Key": key,
      ...(useCookie && cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`);
  assert.equal(response.headers.get("cache-control"), "no-store", `${path}: private data must not be cached`);
  checked++;
  return { value, response };
};
try {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(`Local server exited: ${serverLog}`);
    if (serverLog.includes("Ready in")) break;
    if (attempt === 119) throw new Error(`Local server was not ready: ${serverLog}`);
    await pause(250);
  }
  await request("/api/v1/economy", { expected: 401 });
  const registration = await request("/api/v1/bootstrap", { method: "POST", expected: 201,
    body: { displayName: "Проверка пути игрока", timeZone: "Europe/Moscow" } });
  cookie = registration.response.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
  assert.ok(cookie, "Registration must establish the local session");
  const checkInKey = crypto.randomUUID();
  await request("/api/v1/check-ins", { method: "POST", key: checkInKey });
  const repeatedCheckIn = await request("/api/v1/check-ins", { method: "POST", key: checkInKey });
  assert.equal(repeatedCheckIn.value.replayed, true);
  const initial = (await request("/api/v1/economy")).value;
  assert.equal(initial.buildings.home, 1); assert.equal(initial.buildings.warehouse, 1);
  assert.equal(initial.wallet.coins, 0); assert.equal(initial.jobs.length, 0);
  const command = (state, action, targetId, quantity = 1) => ({ requestId: crypto.randomUUID(), ownerPublicId: state.ownerPublicId,
    expectedRevision: state.revision, action, targetId, quantity, totalPrice: 0 });
  const send = (body, expected = 200) => request("/api/v1/economy/commands", { method: "POST", body, expected });
  const oversized = await send(command(initial, "start_production", "grow_berries", 2), 400);
  assert.equal(oversized.value.code, "INVALID_ECONOMY_COMMAND");
  const order = command(initial, "start_production", "grow_berries");
  const planted = (await send(order)).value;
  assert.equal(planted.state.jobs.length, 1);
  assert.equal(planted.state.jobs[0].rewards.berries, initial.catalog.recipes.find(recipe => recipe.id === "grow_berries").rewards.berries);
  const replayed = (await send(order)).value;
  assert.equal(replayed.replayed, true); assert.equal(replayed.state.jobs.length, 1);
  assert.equal(replayed.acceptedRevision, planted.acceptedRevision);
  await send(command(planted.state, "claim_job", planted.state.jobs[0].id), 409);
  await send(command(initial, "start_exploration", "shore"), 409);
  const refreshed = (await request("/api/v1/economy")).value;
  assert.equal(refreshed.revision, planted.state.revision);
  assert.deepEqual(refreshed.jobs, planted.state.jobs);
  const trip = (await send(command(refreshed, "start_exploration", "shore"))).value.state;
  const exploration = trip.jobs.find(job => job.kind === "exploration");
  assert.ok(exploration, "First free fishing trip is available while berries grow");
  const cancelled = (await send(command(trip, "cancel_exploration", exploration.id))).value.state;
  assert.equal(cancelled.completedExplorations, 0);
  assert.deepEqual(cancelled.inventory, initial.inventory);
  assert.equal(cancelled.jobs.length, 1, "Cancelling a trip preserves the crop");
  await send(command(cancelled, "claim_job", exploration.id), 409);
  await send(command(cancelled, "start_construction", "home"), 409);
  const market = await request("/api/v1/economy/market/commands", { method: "POST", expected: 409,
    body: { ...command(cancelled, "create_listing", "wood"), totalPrice: 4 } });
  assert.equal(market.value.code, "ECONOMY_MARKET_LOCKED");
  const final = (await request("/api/v1/economy")).value;
  assert.equal(final.revision, cancelled.revision); assert.deepEqual(final.wallet, cancelled.wallet);
  await request("/api/v1/admin/economy", { expected: 503 });
  for (const path of ["/", "/branch", "/prototype/tiled-world"]) {
    const response = await fetch(`${origin}${path}`, { headers: { Cookie: cookie }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, `${path} must render`);
    assert.match(await response.text(), /<html/); checked++;
  }
  console.log(JSON.stringify({ passed: checked, environment: "local Next memory API", initialCoins: initial.wallet.coins,
    storageCapacity: initial.storage.capacity, firstCrop: planted.state.jobs[0].rewards,
    firstCropSeconds: (Date.parse(planted.state.jobs[0].finishesAt) - Date.parse(planted.state.jobs[0].startedAt)) / 1000,
    registration: "ok", checkInReplay: "ok", orderReplay: "ok", revisionRecovery: "ok", earlyClaim: "rejected",
    cancellation: "no rewards; crop preserved", market: "locked", admin: "unavailable in local API",
    limitations: "HTTP and server-rendered pages only; no browser layout, real OAuth, PostgreSQL or elapsed crop completion" }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  cookie = "";
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise(resolve => server.once("exit", resolve)), pause(5000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
}

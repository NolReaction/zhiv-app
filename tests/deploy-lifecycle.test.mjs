import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, access, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { appBuildId, writeAppBuildStatus } from "../scripts/app-build.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));

test("both build commands share the same immutable embedded ID and public status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zhiv-build-status-"));
  try {
    const packageJson = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
    await writeFile(join(directory, "package.json"), JSON.stringify(packageJson));
    await symlink(join(repository, "node_modules"), join(directory, "node_modules"), "dir");
    assert.match(packageJson.scripts.build, /app-build\.mjs -- bash scripts\/build-verified\.sh$/);
    assert.match(packageJson.scripts["build:vps"], /app-build\.mjs -- next build$/);
    const result = spawnSync(process.execPath, [join(repository, "scripts/app-build.mjs"), "--", process.execPath, "-e",
      'console.log(JSON.stringify({embedded:process.env.NEXT_PUBLIC_APP_BUILD_ID,status:JSON.parse(require("node:fs").readFileSync("public/app-status.json","utf8"))}))'],
    { cwd: directory, env: { ...process.env, APP_BUILD_ID: "release-test-123" }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    await access(join(directory, "public/vendor", `maplibre-gl-${packageJson.dependencies["maplibre-gl"]}`, "maplibre-gl-worker.mjs"));
    assert.deepEqual(JSON.parse(result.stdout), { embedded: "release-test-123", status: { schemaVersion: 1, buildId: "release-test-123", maintenance: false } });
    assert.notEqual(appBuildId(""), appBuildId(""));
    assert.throws(() => appBuildId('bad"value'), /Invalid/);
    await writeAppBuildStatus(directory, "next-build");
    assert.equal(JSON.parse(await readFile(join(directory, "public/app-status.json"), "utf8")).buildId, "next-build");
    const failed = spawnSync(process.execPath, [join(repository, "scripts/app-build.mjs"), "--", process.execPath, "-e", "process.exit(7)"], { cwd: directory });
    assert.equal(failed.status, 7);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function simulateDeploy(failCommand = "", { alerts = false, webhook = "https://alerts.example.invalid/private-test", args = [] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zhiv-deploy-test-"));
  const project = join(directory, "app");
  await mkdir(join(project, "scripts/lib"), { recursive: true });
  await mkdir(join(project, "deploy/runtime"), { recursive: true });
  await mkdir(join(directory, "bin"));
  await copyFile(join(repository, "scripts/deploy-update.sh"), join(project, "scripts/deploy-update.sh"));
  await copyFile(join(repository, "scripts/lib/reset-game-progress.sh"), join(project, "scripts/lib/reset-game-progress.sh"));
  await copyFile(join(repository, "scripts/reset-game-progress.sql"), join(project, "scripts/reset-game-progress.sql"));
  await writeFile(join(project, "scripts/restore-backup-drill.py"), `import json, os, pathlib, sys
root = pathlib.Path.cwd() / 'deploy/runtime'
args = sys.argv[1:]
assert args[-1] == '--execute'
assert pathlib.Path(args[0]).read_text() == 'verified-backup'
with open(os.environ['DEPLOY_TEST_LOG'], 'a') as log:
    log.write(json.dumps({'command': 'restore-drill --execute', 'options': [], 'gated': (root / 'maintenance').exists(), 'status': json.loads((root / 'app-status.json').read_text())}) + '\\n')
if os.environ.get('DEPLOY_TEST_FAIL') == 'restore-drill': sys.exit(42)
`);
  if (alerts) {
    await copyFile(join(repository, "scripts/check-alert-delivery.py"), join(project, "scripts/check-alert-delivery.py"));
    await mkdir(join(project, "deploy/.secrets"), { mode: 0o700 });
    await mkdir(join(project, "deploy/.secrets/alerts"));
    await writeFile(join(project, "deploy/.secrets/alerts/webhook_url"), `${webhook}\n`, { mode: 0o444 });
    await writeFile(join(project, "deploy/.secrets/alerts/enabled"), "");
  }
  await writeFile(join(directory, "bin/git"), '#!/bin/sh\nif [ "$1" = rev-parse ]; then echo abcdef123456; fi\n', { mode: 0o755 });
  // Model sudo's environment reset even when this test runner itself is root.
  await writeFile(join(directory, "bin/docker"), '#!/bin/sh\nunset APP_BUILD_ID\nexec node -- "$0.js" "$@"\n', { mode: 0o755 });
  await writeFile(join(directory, "bin/docker.js"), `
const fs = require("node:fs");
const args = process.argv.slice(2);
let offset = 1;
while (["--env-file", "-f", "--profile"].includes(args[offset])) offset += 2;
const commandArgs = args.slice(offset);
const command = commandArgs.join(" ");
const root = process.cwd() + "/deploy/runtime/";
const status = fs.existsSync(root+"app-status.json") ? JSON.parse(fs.readFileSync(root+"app-status.json","utf8")) : null;
fs.appendFileSync(process.env.DEPLOY_TEST_LOG, JSON.stringify({command,options:args.slice(0,offset),status,gated:fs.existsSync(root+"maintenance"),environmentBuildId:process.env.APP_BUILD_ID ?? null})+"\\n");
if (process.env.DEPLOY_TEST_FAIL && command.includes(process.env.DEPLOY_TEST_FAIL)) process.exit(42);
if (commandArgs[0] === "build") {
  const buildArguments = args.filter((argument, index) => args[index - 1] === "--build-arg");
  const explicitId = buildArguments.find(argument => argument.startsWith("APP_BUILD_ID="))?.slice("APP_BUILD_ID=".length);
  // app-build.mjs generates a fresh ID when Docker receives no release ID.
  fs.writeFileSync(root+"built-status.json", JSON.stringify({schemaVersion:1,buildId:explicitId || require("node:crypto").randomUUID(),maintenance:false}));
}
if (commandArgs[0] === "exec" && args.some(argument => argument.startsWith("EXPECTED_BUILD_ID="))) {
  const expected = args.find(argument => argument.startsWith("EXPECTED_BUILD_ID=")).slice("EXPECTED_BUILD_ID=".length);
  const status = JSON.parse(fs.readFileSync(root+"built-status.json", "utf8"));
  const script = args[args.indexOf("node") + 2];
  // Execute the deployment's real comparison, substituting only the HTTP reply.
  const response = "global.fetch = async () => ({ok:true,json:async () => (" + JSON.stringify(status) + ")});\\n";
  const result = require("node:child_process").spawnSync(process.execPath, ["-e", response + script], {
    env: {...process.env, EXPECTED_BUILD_ID:expected}, encoding:"utf8", timeout:5_000,
  });
  process.stderr.write(result.stderr || "");
  process.exit(result.status ?? 1);
}
if (command.includes("pg_dump")) process.stdout.write("verified-backup");
if (command.includes("pg_restore") || command.includes("psql")) fs.readFileSync(0);
if (command === "ps --services --status running" && process.env.DEPLOY_TEST_ALERTS === "yes") process.stdout.write("prometheus\\n");
`);
  await writeFile(join(directory, "bin/flock"), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // The real script uses sudo for non-root operators; this shim only invokes our fake docker.
  await writeFile(join(directory, "bin/sudo"), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  const log = join(directory, "events.jsonl");
  const result = spawnSync("bash", [join(project, "scripts/deploy-update.sh"), ...args], {
    cwd: project, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH}`, DEPLOY_TEST_LOG: log, DEPLOY_TEST_FAIL: failCommand, DEPLOY_TEST_ALERTS: alerts ? "yes" : "no" },
  });
  assert.notEqual(result.error?.code, "ETIMEDOUT", result.stderr);
  const events = (await readFile(log, "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { directory, project, result, events };
}

test("deployment stops writers before backup, verifies restoration, then migrates and reopens only after health checks", async () => {
  const run = await simulateDeploy();
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    const index = text => run.events.findIndex(event => event.command.includes(text));
    assert.ok(index("build") < index("pg_dump"));
    assert.ok(index("force-recreate") < index("stop --timeout 30 web api"));
    assert.ok(index("stop --timeout 30 web api") < index("pg_dump"));
    assert.ok(index("pg_dump") < index("pg_restore"));
    assert.ok(index("pg_restore") < index("restore-drill --execute"));
    assert.ok(index("restore-drill --execute") < index("600 db provision migrate api web"));
    assert.ok(!run.events.some(event => event.command.includes("apply_reset=on")), "ordinary deployments never opt into a reset");
    assert.equal(run.events[index("pg_dump")].gated, true);
    const gated = run.events.filter(event => event.gated);
    assert.ok(gated.length > 4);
    assert.ok(gated.every(event => event.status.maintenance === true));
    const expected = run.events.find(event => event.command.includes("EXPECTED_BUILD_ID="));
    const build = run.events.find(event => event.command.startsWith("build"));
    assert.equal(build.environmentBuildId, null, "sudo must not preserve the caller's release environment in this regression");
    assert.ok(build.command.includes(`--build-arg APP_BUILD_ID=${expected.status.buildId}`), "the image must receive the same ID through an explicit Docker argument");
    const built = JSON.parse(await readFile(join(run.project, "deploy/runtime/built-status.json"), "utf8"));
    assert.equal(built.buildId, expected.status.buildId);
    assert.ok(expected.command.includes(`EXPECTED_BUILD_ID=${expected.status.buildId}`));
    assert.ok(expected.command.includes("status.buildId !== process.env.EXPECTED_BUILD_ID"));
    const ready = JSON.parse(await readFile(join(run.project, "deploy/runtime/app-status.json"), "utf8"));
    assert.equal(ready.maintenance, false);
    assert.equal(ready.buildId, expected.status.buildId);
    await assert.rejects(access(join(run.project, "deploy/runtime/maintenance")));
  } finally { await rm(run.directory, { recursive: true, force: true }); }
});

test("explicit 0.7.1 fresh start migrates and rehearses while writers remain stopped, then reopens", async () => {
  const run = await simulateDeploy("", { args: ["--reset-game-progress-0.7.1"] });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    const index = pattern => run.events.findIndex(event => pattern.test(event.command));
    const stopped = index(/stop --timeout 30 web api$/);
    const beforeMigrationRestore = index(/restore-drill --execute/);
    const provision = index(/run --rm --no-deps provision$/), migrate = index(/run --rm --no-deps migrate$/);
    const preview = index(/psql .* -d zhiv .*apply_reset=off/);
    const resetBackup = run.events.findIndex((event, position) => position > preview && event.command.includes("pg_dump"));
    const resetRestore = index(/pg_restore .*zhiv_game_reset_verify_.*--exit-on-error/);
    const rehearsal = index(/psql .* -d zhiv_game_reset_verify_.*apply_reset=on/);
    const liveReset = index(/psql .* -d zhiv .*apply_reset=on/);
    const start = index(/up -d --no-deps --no-build --wait --wait-timeout 600 api web$/);
    assert.ok(stopped < beforeMigrationRestore && beforeMigrationRestore < provision && provision < migrate);
    assert.ok(migrate < preview && preview < resetBackup && resetBackup < resetRestore);
    assert.ok(resetRestore < rehearsal && rehearsal < liveReset && liveReset < start);
    assert.ok(run.events.slice(stopped, start + 1).every(event => event.gated && event.status.maintenance));
    assert.ok(!run.events.slice(stopped, start).some(event => /^up .*\b(api|web)\b/.test(event.command)));
    assert.equal(JSON.parse(await readFile(join(run.project, "deploy/runtime/app-status.json"), "utf8")).maintenance, false);
    await assert.rejects(access(join(run.project, "deploy/runtime/maintenance")));
  } finally { await rm(run.directory, { recursive: true, force: true }); }
});

test("a failed fresh-start migration, restore or rehearsal cannot apply live reset or reopen writers", async () => {
  for (const failure of ["run --rm --no-deps migrate", "--exit-on-error", "-d zhiv_game_reset_verify_"]) {
    const run = await simulateDeploy(failure, { args: ["--reset-game-progress-0.7.1"] });
    try {
      assert.equal(run.result.status, 42, run.result.stderr);
      assert.ok(!run.events.some(event => /psql .* -d zhiv .*apply_reset=on/.test(event.command)));
      assert.ok(!run.events.some(event => /up .*600 api web$/.test(event.command)));
      await access(join(run.project, "deploy/runtime/maintenance"));
      assert.equal(JSON.parse(await readFile(join(run.project, "deploy/runtime/app-status.json"), "utf8")).maintenance, true);
    } finally { await rm(run.directory, { recursive: true, force: true }); }
  }
});

test("unknown deployment options fail before Git, Docker or maintenance", async () => {
  const run = await simulateDeploy("", { args: ["--reset-game-progress-0.7.2"] });
  try {
    assert.equal(run.result.status, 2);
    assert.deepEqual(run.events, []);
    await assert.rejects(access(join(run.project, "deploy/runtime/maintenance")));
  } finally { await rm(run.directory, { recursive: true, force: true }); }
});

test("optional alert delivery survives deploy recreation and notifier failure does not close a healthy game", async () => {
  for (const failCommand of ["", "90 prometheus node-exporter alertmanager"]) {
    const run = await simulateDeploy(failCommand, { alerts: true });
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.ok(run.events.length > 10);
      assert.ok(run.events.filter(event => !event.command.startsWith("restore-drill")).every(event => event.options.includes("deploy/monitoring/alerting.compose.yml")));
      const validation = run.events.find(event => event.command.includes("amtool"));
      assert.equal(validation.gated, false, "receiver validation must precede maintenance");
      assert.ok(run.events.some(event => event.command.includes("90 prometheus node-exporter alertmanager")));
      assert.equal(JSON.parse(await readFile(join(run.project, "deploy/runtime/app-status.json"), "utf8")).maintenance, false);
      await assert.rejects(access(join(run.project, "deploy/runtime/maintenance")));
      if (failCommand) assert.match(run.result.stderr, /External alert delivery did not start/);
    } finally { await rm(run.directory, { recursive: true, force: true }); }
  }
});

test("collector validation or recreation failure happens after reopening and cannot gate a healthy game", async () => {
  for (const failCommand of ["check rules /etc/prometheus/alerts.yml", "--force-recreate --wait --wait-timeout 90 prometheus"]) {
    const run = await simulateDeploy(failCommand, { alerts: true });
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      const failed = run.events.find(event => event.command.includes(failCommand));
      assert.ok(failed, "the requested failure must actually execute");
      assert.equal(failed.gated, false);
      assert.equal(failed.status.maintenance, false);
      const applicationReady = run.events.findIndex(event => event.command.includes("EXPECTED_BUILD_ID="));
      assert.ok(run.events.indexOf(failed) > applicationReady);
      assert.match(run.result.stderr, /WARNING: Monitoring/);
      assert.ok(!run.events.some(event => event.command.includes("90 prometheus node-exporter alertmanager")), "a later optional startup must not bypass the failed collector validation/restart");
      assert.equal(JSON.parse(await readFile(join(run.project, "deploy/runtime/app-status.json"), "utf8")).maintenance, false);
      await assert.rejects(access(join(run.project, "deploy/runtime/maintenance")));
      if (failCommand.startsWith("check rules")) {
        assert.ok(!run.events.some(event => event.command.includes("--force-recreate --wait --wait-timeout 90 prometheus")), "invalid rules must not force-restart the running collector");
      }
    } finally { await rm(run.directory, { recursive: true, force: true }); }
  }
});

test("bad optional notification secrets fail before Docker or maintenance without disclosing the destination", async () => {
  const secret = "http://private.example.invalid/SENSITIVE_TOKEN";
  const run = await simulateDeploy("", { alerts: true, webhook: secret });
  try {
    assert.equal(run.result.status, 1);
    assert.equal(run.events.length, 0);
    assert.ok(!(run.result.stdout + run.result.stderr).includes("SENSITIVE_TOKEN"));
    await assert.rejects(access(join(run.project, "deploy/runtime/maintenance")));
  } finally { await rm(run.directory, { recursive: true, force: true }); }
});

test("failed replacement or mismatched web health never announces ready or removes the gate", async () => {
  for (const failCommand of ["pg_dump", "pg_restore", "restore-drill", "600 db provision migrate api web", "EXPECTED_BUILD_ID="]) {
    const run = await simulateDeploy(failCommand);
    try {
      assert.equal(run.result.status, 42);
      const status = JSON.parse(await readFile(join(run.project, "deploy/runtime/app-status.json"), "utf8"));
      assert.equal(status.maintenance, true);
      assert.match(status.message, /задержалось/);
      await access(join(run.project, "deploy/runtime/maintenance"));
      assert.match(run.result.stderr, /maintenance remains enabled/);
      if (["pg_dump", "pg_restore", "restore-drill"].includes(failCommand)) {
        assert.ok(!run.events.some(event => event.command.includes("db provision migrate api web")), "a bad backup must never allow migrations");
      }
    } finally { await rm(run.directory, { recursive: true, force: true }); }
  }
});

test("build or edge validation failure leaves the running application untouched", async () => {
  for (const failCommand of ["build", "caddy validate"]) {
    const run = await simulateDeploy(failCommand);
    try {
      assert.equal(run.result.status, 42);
      assert.ok(run.events.every(event => !event.gated));
      assert.ok(run.events.every(event => !event.command.startsWith("stop ") && !event.command.startsWith("up ")));
      await assert.rejects(access(join(run.project, "deploy/runtime/maintenance")));
    } finally { await rm(run.directory, { recursive: true, force: true }); }
  }
});

test("Caddy serves lifecycle JSON ahead of the maintenance gate and blocks both API and web", async () => {
  const caddy = await readFile(join(repository, "deploy/Caddyfile"), "utf8");
  assert.ok(caddy.indexOf("handle /app-status.json") < caddy.indexOf("handle @maintenance"));
  assert.ok(caddy.indexOf("handle @maintenance") < caddy.indexOf("handle @api"));
  assert.match(caddy, /handle \/app-status\.json[\s\S]*?header Cache-Control "no-store"[\s\S]*?file_server/);
  assert.match(caddy, /handle @maintenance[\s\S]*?Retry-After "15"[\s\S]*?respond .* 503/);
  const compose = await readFile(join(repository, "deploy/compose.yml"), "utf8");
  assert.match(compose, /\.\/runtime:\/srv\/deploy:ro/);
  assert.match(compose, /APP_BUILD_ID: \$\{APP_BUILD_ID:-\}/);
});

test("Caddy sends only the exact public weather GET to web after maintenance and before the Ktor API catch-all", async () => {
  const caddy = await readFile(join(repository, "deploy/Caddyfile"), "utf8");
  const matcher = caddy.match(/@earthWeather\s*\{([^{}]+)\}/)?.[1].trim().replace(/\s+/g, " ");
  assert.equal(matcher, "method GET path /api/v1/earth/weather", "do not divert other API paths or write methods to the web runtime");
  assert.match(caddy, /handle @earthWeather\s*\{\s*reverse_proxy web:3000\s*\}/);
  assert.ok(caddy.indexOf("handle @maintenance") < caddy.indexOf("handle @earthWeather"));
  assert.ok(caddy.indexOf("handle @earthWeather") < caddy.indexOf("handle @api"));
  assert.match(caddy, /@api path \/api\/\* \/healthz \/readyz\s*handle @api\s*\{\s*reverse_proxy api:8080\s*\}/,
    "the remaining API, health and readiness routes retain the Ktor upstream");
});

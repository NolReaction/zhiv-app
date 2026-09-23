import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, access } from "node:fs/promises";
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
    assert.match(packageJson.scripts.build, /app-build\.mjs -- bash scripts\/build-verified\.sh$/);
    assert.match(packageJson.scripts["build:vps"], /app-build\.mjs -- next build$/);
    const result = spawnSync(process.execPath, [join(repository, "scripts/app-build.mjs"), "--", process.execPath, "-e",
      'console.log(JSON.stringify({embedded:process.env.NEXT_PUBLIC_APP_BUILD_ID,status:JSON.parse(require("node:fs").readFileSync("public/app-status.json","utf8"))}))'],
    { cwd: directory, env: { ...process.env, APP_BUILD_ID: "release-test-123" }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { embedded: "release-test-123", status: { schemaVersion: 1, buildId: "release-test-123", maintenance: false } });
    assert.notEqual(appBuildId(""), appBuildId(""));
    assert.throws(() => appBuildId('bad"value'), /Invalid/);
    await writeAppBuildStatus(directory, "next-build");
    assert.equal(JSON.parse(await readFile(join(directory, "public/app-status.json"), "utf8")).buildId, "next-build");
    const failed = spawnSync(process.execPath, [join(repository, "scripts/app-build.mjs"), "--", process.execPath, "-e", "process.exit(7)"], { cwd: directory });
    assert.equal(failed.status, 7);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function simulateDeploy(failCommand = "") {
  const directory = await mkdtemp(join(tmpdir(), "zhiv-deploy-test-"));
  const project = join(directory, "app");
  await mkdir(join(project, "scripts"), { recursive: true });
  await mkdir(join(project, "deploy/runtime"), { recursive: true });
  await mkdir(join(directory, "bin"));
  await copyFile(join(repository, "scripts/deploy-update.sh"), join(project, "scripts/deploy-update.sh"));
  await writeFile(join(directory, "bin/git"), '#!/bin/sh\nif [ "$1" = rev-parse ]; then echo abcdef123456; fi\n', { mode: 0o755 });
  await writeFile(join(directory, "bin/docker"), '#!/bin/sh\nexec node -- "$0.js" "$@"\n', { mode: 0o755 });
  await writeFile(join(directory, "bin/docker.js"), `
const fs = require("node:fs");
const args = process.argv.slice(2);
const command = args.slice(5).join(" ");
const root = process.cwd() + "/deploy/runtime/";
const status = fs.existsSync(root+"app-status.json") ? JSON.parse(fs.readFileSync(root+"app-status.json","utf8")) : null;
fs.appendFileSync(process.env.DEPLOY_TEST_LOG, JSON.stringify({command,status,gated:fs.existsSync(root+"maintenance")})+"\\n");
if (process.env.DEPLOY_TEST_FAIL && command.includes(process.env.DEPLOY_TEST_FAIL)) process.exit(42);
if (command.includes("pg_dump")) process.stdout.write("verified-backup");
if (command.includes("pg_restore")) fs.readFileSync(0);
`);
  await writeFile(join(directory, "bin/flock"), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // The real script uses sudo for non-root operators; this shim only invokes our fake docker.
  await writeFile(join(directory, "bin/sudo"), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  const log = join(directory, "events.jsonl");
  const result = spawnSync("bash", [join(project, "scripts/deploy-update.sh")], {
    cwd: project, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH}`, DEPLOY_TEST_LOG: log, DEPLOY_TEST_FAIL: failCommand },
  });
  assert.notEqual(result.error?.code, "ETIMEDOUT", result.stderr);
  const events = (await readFile(log, "utf8").catch(() => { throw new Error(`Deploy simulator did not start: ${result.stderr}`); }))
    .trim().split("\n").map(line => JSON.parse(line));
  return { directory, project, result, events };
}

test("deployment builds and backs up live, gates before stopping API, then reopens only after health and build checks", async () => {
  const run = await simulateDeploy();
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    const index = text => run.events.findIndex(event => event.command.includes(text));
    assert.ok(index("build") < index("pg_dump"));
    assert.ok(index("pg_restore") < index("force-recreate"));
    assert.ok(index("force-recreate") < index("stop --timeout 30 web api"));
    assert.ok(index("stop --timeout 30 web api") < index("240 db provision migrate api web"));
    assert.equal(run.events[index("pg_dump")].gated, false);
    const gated = run.events.filter(event => event.gated);
    assert.ok(gated.length > 4);
    assert.ok(gated.every(event => event.status.maintenance === true));
    const expected = run.events.find(event => event.command.includes("EXPECTED_BUILD_ID="));
    assert.ok(expected.command.includes(`EXPECTED_BUILD_ID=${expected.status.buildId}`));
    assert.ok(expected.command.includes("status.buildId !== process.env.EXPECTED_BUILD_ID"));
    const ready = JSON.parse(await readFile(join(run.project, "deploy/runtime/app-status.json"), "utf8"));
    assert.equal(ready.maintenance, false);
    assert.equal(ready.buildId, expected.status.buildId);
    await assert.rejects(access(join(run.project, "deploy/runtime/maintenance")));
  } finally { await rm(run.directory, { recursive: true, force: true }); }
});

test("failed replacement or mismatched web health never announces ready or removes the gate", async () => {
  for (const failCommand of ["240 db provision migrate api web", "EXPECTED_BUILD_ID="]) {
    const run = await simulateDeploy(failCommand);
    try {
      assert.equal(run.result.status, 42);
      const status = JSON.parse(await readFile(join(run.project, "deploy/runtime/app-status.json"), "utf8"));
      assert.equal(status.maintenance, true);
      assert.match(status.message, /задержалось/);
      await access(join(run.project, "deploy/runtime/maintenance"));
      assert.match(run.result.stderr, /maintenance remains enabled/);
    } finally { await rm(run.directory, { recursive: true, force: true }); }
  }
});

test("build or backup failure leaves the running application untouched", async () => {
  for (const failCommand of ["build", "pg_restore"]) {
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

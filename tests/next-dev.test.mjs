import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkNextDevDependencies, nextDevArguments, validateNextDevDependencies } from "../scripts/next-dev.mjs";

const launcher = fileURLToPath(new URL("../scripts/next-dev.mjs", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const versions = Object.fromEntries(["next", "react", "react-dom"].map(name => [name, manifest.dependencies[name]]));

async function fixture(t, overrides = {}, cli = "process.exit(0);") {
  const root = await mkdtemp(join(tmpdir(), "zhiv-next-dev-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: versions }));
  for (const [name, version] of Object.entries({ ...versions, ...overrides })) {
    if (!version) continue;
    const directory = join(root, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, version }));
  }
  const directory = join(root, "node_modules/next/dist/bin");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "next"), cli);
  return root;
}

test("the development dependency check accepts matching pinned versions", () => {
  assert.doesNotThrow(() => validateNextDevDependencies(manifest, versions));
});

test("an old framework or React install fails with actionable reinstall and restart instructions", () => {
  assert.throws(() => validateNextDevDependencies(manifest, { next: "16.3.4", react: "19.0.0" }), error => {
    assert.match(error.message, /next: expected .* installed 16\.3\.4/);
    assert.match(error.message, /react: expected .* installed 19\.0\.0/);
    assert.match(error.message, /react-dom: expected .* installed missing/);
    assert.match(error.message, /npm ci/);
    assert.match(error.message, /Stop the running development server/);
    return true;
  });
});

test("dependency discovery uses the selected project rather than the launcher's install", async t => {
  const root = await fixture(t);
  const checked = checkNextDevDependencies(root);
  assert.deepEqual(checked.versions, versions);
  assert.equal(checked.nextBin, join(root, "node_modules/next/dist/bin/next"));
  const missingReact = await fixture(t, { react: null });
  assert.throws(() => checkNextDevDependencies(missingReact), /react: expected .* installed missing/);
});

test("development arguments preserve the hostname, port and additional options", () => {
  const args = ["--hostname", "0.0.0.0", "--port", "4321", "--disable-source-maps"];
  assert.deepEqual(nextDevArguments(args), ["dev", "--webpack", ...args]);
  assert.deepEqual(args, ["--hostname", "0.0.0.0", "--port", "4321", "--disable-source-maps"]);
});

test("the launcher forwards arguments and environment and preserves the child exit code", async t => {
  const root = await fixture(t, {}, `console.log(JSON.stringify({ args: process.argv.slice(2), marker: process.env.ZHIV_LAUNCHER_TEST })); process.exit(7);`);
  const result = spawnSync(process.execPath, [launcher, "--hostname", "0.0.0.0", "--port", "4321"], {
    cwd: root, env: { ...process.env, ZHIV_LAUNCHER_TEST: "inherited" }, encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 7);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { args: ["dev", "--webpack", "--hostname", "0.0.0.0", "--port", "4321"], marker: "inherited" });
});

test("the development launcher enables DEV even when the shell exports production or test", async t => {
  const root = await fixture(t, {}, `console.log(process.env.NODE_ENV);`);
  for (const mode of [undefined, "development", "production", "test"]) {
    const env = { ...process.env };
    if (mode === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = mode;
    const result = spawnSync(process.execPath, [launcher], { cwd: root, env, encoding: "utf8", timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `inherited NODE_ENV=${mode}`);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim(), "development", `inherited NODE_ENV=${mode}`);
  }
});

test("the launcher rejects mismatched dependencies before starting Next", async t => {
  const root = await fixture(t, { next: "16.3.4" }, `console.log("NEXT_STARTED");`);
  const result = spawnSync(process.execPath, [launcher], { cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /installed 16\.3\.4/);
  assert.match(result.stderr, /npm ci/);
});

test("termination is forwarded to Next and retained as the launcher's exit signal", { timeout: 10_000 }, async t => {
  const root = await fixture(t, {}, `console.log("READY"); setTimeout(() => process.exit(99), 4000);`);
  const child = spawn(process.execPath, [launcher], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  const exit = once(child, "exit");
  const [ready] = await once(child.stdout, "data");
  assert.match(ready.toString(), /READY/);
  child.kill("SIGTERM");
  const [code, signal] = await exit;
  assert.equal(code, null);
  assert.equal(signal, "SIGTERM");
});

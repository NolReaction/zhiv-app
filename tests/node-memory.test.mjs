import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { boundedNodeArguments, nodeMemoryEnvironment, recommendedNodeHeapMb } from "../scripts/lib/node-memory.mjs";
import { acquireHeavyTaskLock } from "../scripts/run-node.mjs";

const gib = 1024 ** 3;
test("heap budget uses the container limit, reserves native memory and caps large hosts", () => {
  assert.equal(recommendedNodeHeapMb(32 * gib, 8 * gib), 3584);
  assert.equal(recommendedNodeHeapMb(32 * gib, 4 * gib), 2432);
  assert.equal(recommendedNodeHeapMb(2 * gib), 1152);
});
test("explicit memory settings and other NODE_OPTIONS survive unchanged", () => {
  const existing = { NODE_OPTIONS: "--enable-source-maps --max_old_space_size=2048", ZHIV_NODE_HEAP_MB: "4096" };
  assert.deepEqual(nodeMemoryEnvironment(existing).env, existing);
  assert.equal(nodeMemoryEnvironment({ NODE_OPTIONS: "--enable-source-maps", ZHIV_NODE_HEAP_MB: "4096" }).env.NODE_OPTIONS,
    "--enable-source-maps --max-old-space-size=4096");
  assert.throws(() => nodeMemoryEnvironment({ ZHIV_NODE_HEAP_MB: "unlimited" }), /integer/);
});
test("test files default to one worker without changing explicit concurrency or ordinary scripts", () => {
  assert.deepEqual(boundedNodeArguments(["--test", "example.test.mjs"]), ["--test-concurrency=1", "--test", "example.test.mjs"]);
  assert.deepEqual(boundedNodeArguments(["--test", "--test-concurrency=2"]), ["--test", "--test-concurrency=2"]);
  assert.deepEqual(boundedNodeArguments(["script.mjs"]), ["script.mjs"]);
});
test("launcher applies the configured heap in the actual child and preserves its failure code", () => {
  const launcher = new URL("../scripts/run-node.mjs", import.meta.url);
  const env = { ...process.env, NODE_OPTIONS: "", ZHIV_NODE_HEAP_MB: "768" };
  const result = spawnSync(process.execPath, [launcher.pathname, "-e", "console.log(require('node:v8').getHeapStatistics().heap_size_limit / 2**20)"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const heap = Number(result.stdout.trim().split("\n").at(-1));
  const direct = spawnSync(process.execPath, ["--max-old-space-size=768", "-e", "console.log(require('node:v8').getHeapStatistics().heap_size_limit / 2**20)"], { env: { ...env, NODE_OPTIONS: "" }, encoding: "utf8" });
  assert.equal(heap, Number(direct.stdout.trim()), "wrapper and explicit Node flag have the same actual heap");
  assert.equal(spawnSync(process.execPath, [launcher.pathname, "-e", "process.exit(7)"], { env }).status, 7);
});
test("nested tasks reuse the checkout lock and a second task waits for release", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhiv-memory-test-"));
  let first;
  try {
    first = await acquireHeavyTaskLock({}, root);
    const nested = await acquireHeavyTaskLock(first.env, root);
    await nested.release();
    let acquired = false;
    const pending = acquireHeavyTaskLock({}, root).then(lock => { acquired = true; return lock; });
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
    assert.equal(acquired, false);
    await first.release();
    const second = await pending;
    assert.equal(acquired, true);
    await second.release();
  } finally { await first?.release(); await rm(root, { recursive: true, force: true }); }
});

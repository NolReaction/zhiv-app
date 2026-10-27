import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtemp, mkdir, copyFile, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyProgressionRerunReceipt, createProgressionRerunReceipt, progressionEvidencePath,
  progressionRerunReceiptPath } from "../scripts/lib/progression-rerun-receipt.mjs";
import { buildProgressionReport, progressionReportPath, readResolvedProgressionEvidence } from "../scripts/build-progression-report.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const bytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const baseline = { schemaVersion: 2, policyVersion: "fixture-v1", generatedAt: "2026-10-26T00:00:00.000Z",
  releaseValidated: true, sourceSha256: { "rules.ts": "old" }, economyVersion: 15, economySha256: "old-catalog",
  rewardsSha256: "same-rewards", policy: { attention: 2 }, scenarios: [{ label: "one", coins: 100 }] };
const rerun = { ...baseline, generatedAt: "2026-10-27T00:00:00.000Z", releaseValidated: false,
  sourceSha256: { "rules.ts": "fresh" }, economySha256: "fresh-catalog" };

test("identical-run receipt binds fresh metadata to exact old bytes and reconstructed complete rerun", () => {
  const receipt = createProgressionRerunReceipt(bytes(baseline), bytes(rerun));
  assert.deepEqual(applyProgressionRerunReceipt(bytes(baseline), receipt), rerun);
  assert.equal(receipt.scenarioCount, 1);
  assert.equal(receipt.rerunReportSha256.length, 64);
  assert.equal(receipt.releaseValidated, false);
  // CI annotation must not claim that the original simulation ran after CI.
  receipt.releaseValidated = true;
  assert.equal(applyProgressionRerunReceipt(bytes(baseline), receipt).releaseValidated, true);
  assert.equal(receipt.runReleaseValidated, false);
});

test("adoption refuses changed results, missing cases, policy changes and noncanonical fresh output", () => {
  for (const patch of [{ scenarios: [{ label: "one", coins: 101 }] }, { scenarios: [] },
    { policy: { attention: 1 } }, { policyVersion: "different" }, { unexpected: true }])
    assert.throws(() => createProgressionRerunReceipt(bytes(baseline), bytes({ ...rerun, ...patch })), /differ|fields changed/);
  assert.throws(() => createProgressionRerunReceipt(bytes(baseline), Buffer.from(JSON.stringify(rerun))), /canonical runner JSON/);
});

test("receipt corruption, replaced baseline and merely substituted source hashes never publish", () => {
  const receipt = createProgressionRerunReceipt(bytes(baseline), bytes(rerun));
  assert.throws(() => applyProgressionRerunReceipt(Buffer.concat([bytes(baseline), Buffer.from(" ")]), receipt), /baseline bytes/);
  for (const patch of [{ scenarioCount: 2 }, { scenariosSha256: "fake" }, { policyVersion: "new" },
    { sourceSha256: { "rules.ts": "substituted-without-full-run" } }, { generatedAt: "not a date" },
    { rerunReportSha256: "fake" }])
    assert.throws(() => applyProgressionRerunReceipt(bytes(baseline), { ...receipt, ...patch }));
});

async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), "zhiv-rerun-receipt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const receipt = JSON.parse(await readFile(join(root, progressionRerunReceiptPath), "utf8"));
  for (const path of [...Object.keys(receipt.sourceSha256), progressionEvidencePath, progressionRerunReceiptPath, progressionReportPath]) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await copyFile(join(root, path), join(directory, path));
  }
  return directory;
}

test("canonical receipt retains strict source freshness and catalog checks", async t => {
  const directory = await sandbox(t);
  const report = await buildProgressionReport({ repositoryRoot: directory, check: true });
  assert.equal(report.scenarios.length, 56);
  const receipt = JSON.parse(await readFile(join(directory, progressionRerunReceiptPath), "utf8"));
  const resolved = await readResolvedProgressionEvidence({ repositoryRoot: directory });
  resolved.releaseValidated = receipt.runReleaseValidated;
  assert.equal(createHash("sha256").update(bytes(resolved)).digest("hex"), receipt.rerunReportSha256,
    "actual production receipt reconstructs every byte of the complete fresh runner output");
  await appendFile(join(directory, "lib/gameplay-generation.ts"), "\n// Changed after the run.\n");
  await assert.rejects(buildProgressionReport({ repositoryRoot: directory, check: true }), /Scenario source has changed/);
});

test("malformed canonical receipt fails closed while explicit independent evidence stays independent", async t => {
  const directory = await sandbox(t);
  const evidence = await readResolvedProgressionEvidence({ repositoryRoot: directory });
  await writeFile(join(directory, "custom-evidence.json"), bytes(evidence));
  await writeFile(join(directory, progressionRerunReceiptPath), "{broken");
  await assert.rejects(buildProgressionReport({ repositoryRoot: directory, check: true }), SyntaxError);
  await writeFile(join(directory, progressionRerunReceiptPath), "null");
  await assert.rejects(buildProgressionReport({ repositoryRoot: directory, check: true }));
  const report = await buildProgressionReport({ sourcePath: "custom-evidence.json", repositoryRoot: directory, check: true });
  assert.equal(report.scenarios.length, 56);
});

test("adoption checks current catalogs and source manifest before persisting a new receipt", async t => {
  const directory = await sandbox(t);
  const fresh = await readResolvedProgressionEvidence({ repositoryRoot: directory });
  fresh.sourceSha256["lib/gameplay-generation.ts"] = "not-current";
  await writeFile(join(directory, "fresh.json"), bytes(fresh));
  const previous = await readFile(join(directory, progressionRerunReceiptPath), "utf8");
  await assert.rejects(buildProgressionReport({ repositoryRoot: directory, adoptIdenticalRun: "fresh.json" }), /Scenario source has changed/);
  assert.equal(await readFile(join(directory, progressionRerunReceiptPath), "utf8"), previous);
  fresh.sourceSha256 = JSON.parse(previous).sourceSha256;
  fresh.economySha256 = "not-current";
  await writeFile(join(directory, "fresh.json"), bytes(fresh));
  await assert.rejects(buildProgressionReport({ repositoryRoot: directory, adoptIdenticalRun: "fresh.json" }), /rerun after catalog changes/);
  assert.equal(await readFile(join(directory, progressionRerunReceiptPath), "utf8"), previous);
});

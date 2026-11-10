import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const progressionEvidencePath = "docs/game/economy-v15-final-scenarios.json";
export const progressionRerunReceiptPath = "docs/game/economy-v15-ship-rerun.json";
const sha256 = value => createHash("sha256").update(value).digest("hex");
const encoded = value => `${JSON.stringify(value, null, 2)}\n`;
const metadataFields = ["generatedAt", "releaseValidated", "sourceSha256", "economySha256", "rewardsSha256"];

/** A fresh full run may reuse unchanged large rows, but never their old source evidence. */
export function createProgressionRerunReceipt(baselineBytes, rerunBytes) {
  const baseline = JSON.parse(baselineBytes.toString()), rerun = JSON.parse(rerunBytes.toString());
  assert.deepEqual(Object.keys(rerun).sort(), Object.keys(baseline).sort(), "Rerun evidence fields changed");
  const unchanged = { ...rerun };
  for (const name of metadataFields) unchanged[name] = baseline[name];
  assert.deepEqual(unchanged, baseline, "Rerun scenarios or policy differ: publish complete new evidence");
  assert.equal(rerunBytes.toString(), encoded(rerun), "Rerun must use the canonical runner JSON encoding");
  const receipt = {
    schemaVersion: 1, baselinePath: progressionEvidencePath,
    baselineSha256: sha256(baselineBytes), rerunReportSha256: sha256(rerunBytes),
    scenariosSha256: sha256(JSON.stringify(rerun.scenarios)), scenarioCount: rerun.scenarios.length,
    sourceSchemaVersion: rerun.schemaVersion, economyVersion: rerun.economyVersion,
    policyVersion: rerun.policyVersion, policySha256: sha256(JSON.stringify(rerun.policy)),
    ...Object.fromEntries(metadataFields.map(name => [name, rerun[name]])),
    runReleaseValidated: rerun.releaseValidated,
  };
  applyProgressionRerunReceipt(baselineBytes, receipt);
  return receipt;
}

/** Every receipt is checked, including the reconstructed full fresh-run hash. */
export function applyProgressionRerunReceipt(baselineBytes, receipt) {
  const baseline = JSON.parse(baselineBytes.toString());
  assert.equal(receipt.schemaVersion, 1, "Unsupported rerun receipt schema");
  assert.equal(receipt.baselinePath, progressionEvidencePath, "Unexpected rerun baseline path");
  assert.equal(receipt.baselineSha256, sha256(baselineBytes), "Rerun baseline bytes changed");
  assert.equal(receipt.sourceSchemaVersion, baseline.schemaVersion, "Rerun source schema changed");
  assert.equal(receipt.economyVersion, baseline.economyVersion, "Rerun economy version changed");
  assert.equal(receipt.policyVersion, baseline.policyVersion, "Rerun policy version changed");
  assert.equal(receipt.policySha256, sha256(JSON.stringify(baseline.policy)), "Rerun policy changed");
  assert.equal(receipt.scenarioCount, baseline.scenarios.length, "Rerun scenario count changed");
  assert.equal(receipt.scenariosSha256, sha256(JSON.stringify(baseline.scenarios)), "Rerun scenario results changed");
  assert.equal(typeof receipt.releaseValidated, "boolean", "Invalid rerun validation status");
  assert.equal(typeof receipt.runReleaseValidated, "boolean", "Invalid original rerun validation status");
  assert(typeof receipt.generatedAt === "string" && Number.isFinite(Date.parse(receipt.generatedAt)), "Invalid rerun date");
  assert(receipt.sourceSha256 && typeof receipt.sourceSha256 === "object" && !Array.isArray(receipt.sourceSha256), "Missing rerun source evidence");
  const rerun = { ...baseline, ...Object.fromEntries(metadataFields.map(name => [name, receipt[name]])) };
  rerun.releaseValidated = receipt.runReleaseValidated;
  assert.equal(receipt.rerunReportSha256, sha256(encoded(rerun)), "Reconstructed rerun report does not match its full-run hash");
  // Release CI is an annotation added after the simulation, not a different run.
  return { ...rerun, releaseValidated: receipt.releaseValidated };
}

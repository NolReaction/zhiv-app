import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { progressionCases } from "./audit-progression-scenarios.mjs";
import { progressionSourceDigests } from "./lib/progression-report-integrity.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Independent processes isolate Vite module snapshots and persist each complete
 * result. A resumed result is accepted only for exactly the same source digests.
 * Final publication still runs build-progression-report's independent checks. */
export async function runProgressionMatrix({ workers = 4, checkpointDirectory, outputPath, resume = false } = {}) {
  assert(Number.isInteger(workers) && workers >= 1 && workers <= 8, "Expected 1–8 workers");
  assert(checkpointDirectory && outputPath, "Explicit checkpoint and output paths are required");
  const directory = resolve(checkpointDirectory), output = resolve(outputPath);
  await mkdir(directory, { recursive: true });
  const sources = await progressionSourceDigests(root);
  const results = new Map();
  const queue = progressionCases.toSorted((a, b) => {
    const cost = row => (row.maxDays ?? 160) * (row.regularActiveMinutes ?? 20) * (row.visitsPerDay ?? 3)
      * (["full", "all-capacity"].includes(row.completionGoal) ? 4 : 1);
    return cost(b) - cost(a);
  });
  let stopped = false;
  async function readResult(path, label) {
    const report = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(report.sourceSha256, sources, `${label}: checkpoint belongs to different source code`);
    assert.equal(report.scenarios.length, 1, `${label}: expected exactly one scenario`);
    assert.equal(report.scenarios[0].label, label);
    return report;
  }
  async function worker() {
    while (!stopped && queue.length) {
      const options = queue.shift(), path = resolve(directory, `${options.label}.json`);
      if (resume) {
        try {
          const report = await readResult(path, options.label);
          results.set(options.label, report);
          process.stdout.write(`${options.label}: resumed\n`);
          continue;
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ERR_ASSERTION") throw error;
        }
      }
      const report = await new Promise((accept, reject) => {
        const child = spawn(process.execPath, [resolve(root, "scripts/audit-progression-scenarios.mjs")], {
          cwd: root, env: { ...process.env, ECONOMY_SOURCE_ROOT: root, SIM_CASES: options.label, SIM_OUTPUT: path },
          stdio: ["ignore", "ignore", "pipe"],
        });
        let diagnostic = "";
        child.stderr.on("data", chunk => { diagnostic += chunk; process.stderr.write(chunk); });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (code !== 0) reject(new Error(`${options.label}: process failed (${code ?? signal}): ${diagnostic.slice(-4000)}`));
          else readResult(path, options.label).then(accept, reject);
        });
      });
      results.set(options.label, report);
    }
  }
  const settled = await Promise.allSettled(Array.from({ length: workers }, async () => {
    try { await worker(); } catch (error) { stopped = true; throw error; }
  }));
  for (const result of settled) if (result.status === "rejected") throw result.reason;
  assert.equal(results.size, progressionCases.length, "Every canonical case must finish before publication");
  assert.deepEqual(await progressionSourceDigests(root), sources, "Sources changed during the matrix; no report published");
  const first = results.get(progressionCases[0].label);
  const report = { ...first, generatedAt: new Date().toISOString(), releaseValidated: false,
    scenarios: progressionCases.map(options => results.get(options.label).scenarios[0]) };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const value = key => process.argv.find(argument => argument.startsWith(`--${key}=`))?.slice(key.length + 3);
  const report = await runProgressionMatrix({ workers: Number(value("workers") ?? 4),
    checkpointDirectory: value("checkpoint"), outputPath: value("output"), resume: process.argv.includes("--resume") });
  process.stdout.write(`Complete matrix: ${report.scenarios.length} scenarios, ${report.policyVersion}\n`);
}

#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectAudioCatalog } from "./lib/audio-catalog.mjs";

const args = process.argv.slice(2);
const unknown = args.filter(arg => !["--require-ready", "--help"].includes(arg));
if (args.includes("--help")) {
  console.log("Usage: node scripts/check-audio.mjs [--require-ready]\nChecks IDs, mixer budgets, local files and license provenance. Pending slots are allowed by default.");
} else if (unknown.length) {
  console.error(`Unknown argument: ${unknown.join(", ")}`);
  process.exitCode = 1;
} else {
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const catalog = JSON.parse(readFileSync(path.join(root, "features/audio/catalog/audio-catalog.json"), "utf8"));
    const { errors, warnings, counts } = inspectAudioCatalog(catalog, { root, requireReady: args.includes("--require-ready") });
    for (const warning of warnings) console.warn(`[audio] ${warning}`);
    for (const error of errors) console.error(`[audio] ${error}`);
    if (errors.length) {
      console.error(`Audio catalog check failed: ${errors.length} issue(s).`);
      process.exitCode = 1;
    } else {
      console.log(`Audio catalog check passed: ${counts.cues} cues, ${counts.profiles} profiles, ${counts.ready} ready / ${counts.pending} pending assets.`);
      if (counts.pending) console.log("Pending slots are intentionally silent; --require-ready requires every variant to be supplied.");
    }
  } catch (error) {
    console.error(`Audio catalog check failed: ${error.message}`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectArchitecture } from "./lib/architecture.mjs";

const root = path.resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
const sources = new Map();
async function readSources(directory) {
  const absolute = path.join(root, directory);
  if (!existsSync(absolute) || !(await stat(absolute)).isDirectory()) return;
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const file = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) await readSources(file);
    else if (/\.[cm]?[jt]sx?$/.test(file)) sources.set(file, await readFile(path.join(root, file), "utf8"));
  }
}
for (const directory of ["app", "features", "components", "lib", "hooks"]) await readSources(directory);
if (!sources.size) {
  console.error(`Architecture check found no application sources in ${root}.`);
  process.exitCode = 1;
} else {
  const diagnostics = inspectArchitecture(sources, { hasFile(file) {
    const absolute = path.resolve(root, file);
    return existsSync(absolute) && statSync(absolute).isFile();
  } });
  if (diagnostics.length) {
    for (const diagnostic of diagnostics) {
      console.error(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column} [${diagnostic.rule}] ${diagnostic.message}`);
    }
    console.error(`Architecture check failed: ${diagnostics.length} issue(s).`);
    process.exitCode = 1;
  } else {
    console.log(`Architecture check passed: ${sources.size} modules; domain, sync, app composition, local imports and feature cycles checked.`);
  }
}

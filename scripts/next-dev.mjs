import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEVELOPMENT_PACKAGES = ["next", "react", "react-dom"];
const RESTART_INSTRUCTIONS = "Stop the running development server, run npm ci, then start it again with npm run dev:local or npm run dev:lan.";

export function validateNextDevDependencies(manifest, installedVersions) {
  const mismatches = DEVELOPMENT_PACKAGES.flatMap(name => {
    const expected = manifest.dependencies?.[name];
    const installed = installedVersions[name];
    return expected && installed === expected ? [] : [`${name}: expected ${expected ?? "a pinned dependency"}, installed ${installed ?? "missing"}`];
  });
  if (mismatches.length) throw new Error(`Development dependencies do not match package.json:\n${mismatches.join("\n")}\n${RESTART_INSTRUCTIONS}`);
}

/** Prevent an old local install from producing chunks for a different framework. */
export function checkNextDevDependencies(projectRoot = process.cwd()) {
  const packagePath = resolve(projectRoot, "package.json");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  const require = createRequire(packagePath);
  const versions = Object.fromEntries(DEVELOPMENT_PACKAGES.map(name => {
    try {
      return [name, require(`${name}/package.json`).version];
    } catch {
      return [name, undefined];
    }
  }));
  validateNextDevDependencies(manifest, versions);
  return { nextBin: require.resolve("next/dist/bin/next"), versions };
}

/** Use webpack in development; production build commands retain their bundler. */
export function nextDevArguments(args = []) {
  return ["dev", "--webpack", ...args];
}

function main() {
  const projectRoot = process.cwd();
  const { nextBin } = checkNextDevDependencies(projectRoot);
  const child = spawn(process.execPath, [nextBin, ...nextDevArguments(process.argv.slice(2))], {
    cwd: projectRoot, env: process.env, stdio: "inherit",
  });
  const forwardInterrupt = () => child.kill("SIGINT");
  const forwardTermination = () => child.kill("SIGTERM");
  const removeSignalHandlers = () => {
    process.off("SIGINT", forwardInterrupt);
    process.off("SIGTERM", forwardTermination);
  };
  process.on("SIGINT", forwardInterrupt);
  process.on("SIGTERM", forwardTermination);
  child.once("error", error => {
    removeSignalHandlers();
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    removeSignalHandlers();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export function appBuildId(value = process.env.APP_BUILD_ID) {
  const buildId = value || `${Date.now().toString(36)}-${randomUUID()}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(buildId)) throw new Error("Invalid APP_BUILD_ID");
  return buildId;
}

export async function writeAppBuildStatus(projectRoot, buildId) {
  const directory = resolve(projectRoot, "public");
  await mkdir(directory, { recursive: true });
  const target = resolve(directory, "app-status.json");
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, buildId, maintenance: false })}\n`, { mode: 0o644 });
  await rename(temporary, target);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  if (args.length === 0) throw new Error("Usage: node scripts/app-build.mjs -- command [args...]");
  const buildId = appBuildId();
  await writeAppBuildStatus(process.cwd(), buildId);
  const child = spawn(args[0], args.slice(1), {
    stdio: "inherit",
    env: { ...process.env, APP_BUILD_ID: buildId, NEXT_PUBLIC_APP_BUILD_ID: buildId },
  });
  const forwardInterrupt = () => child.kill("SIGINT");
  const forwardTermination = () => child.kill("SIGTERM");
  process.on("SIGINT", forwardInterrupt);
  process.on("SIGTERM", forwardTermination);
  child.once("error", error => { console.error(error.message); process.exitCode = 1; });
  child.once("exit", (code, signal) => {
    process.off("SIGINT", forwardInterrupt);
    process.off("SIGTERM", forwardTermination);
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { boundedNodeArguments, nodeMemoryEnvironment } from "./lib/node-memory.mjs";

const pause = milliseconds => new Promise(resolvePause => setTimeout(resolvePause, milliseconds));
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

/** One heavy task per checkout. A nested build/test keeps its parent's lock. */
export async function acquireHeavyTaskLock(env, projectRoot = process.cwd()) {
  const root = await realpath(projectRoot);
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 24);
  const directory = join(tmpdir(), `zhiv-node-task-${digest}`);
  const ownerPath = join(directory, "owner.json");
  const inherited = Number(env.ZHIV_NODE_TASK_OWNER);
  let waiting = false;
  const deadline = Date.now() + 10 * 60_000;
  while (true) {
    try {
      await mkdir(directory, { mode: 0o700 });
      await writeFile(ownerPath, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
      return { env: { ...env, ZHIV_NODE_TASK_OWNER: String(process.pid) }, release: () => rm(directory, { recursive: true, force: true }) };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await readFile(ownerPath, "utf8").then(JSON.parse).catch(() => null);
      if (owner && owner.pid === inherited && isAlive(inherited)) return { env, release: async () => {} };
      if (owner && !isAlive(owner.pid)) {
        await rm(directory, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Another heavy Node task still owns ${directory}; stop that task before retrying.`);
      if (!waiting) { console.info("[node] Waiting for the current build, typecheck or test process in this checkout."); waiting = true; }
      await pause(250);
    }
  }
}

export async function runNode(args = process.argv.slice(2)) {
  const serial = args[0] === "--serial";
  if (serial) args = args.slice(1);
  if (args[0] === "--") args = args.slice(1);
  if (!args.length) throw new Error("Usage: node scripts/run-node.mjs [--serial] [--] <Node arguments or script>");
  const memory = nodeMemoryEnvironment();
  const lock = serial ? await acquireHeavyTaskLock(memory.env) : { env: memory.env, release: async () => {} };
  if (memory.heapMb !== null) console.info(`[node] V8 heap limit ${memory.heapMb} MiB.`);
  try {
    return await new Promise(resolveExit => {
      const child = spawn(process.execPath, boundedNodeArguments(args), { env: lock.env, stdio: "inherit" });
      const interrupt = () => child.kill("SIGINT");
      const terminate = () => child.kill("SIGTERM");
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", terminate);
      const done = code => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); resolveExit(code); };
      child.once("error", error => { console.error(error.message); done(1); });
      child.once("exit", (code, signal) => done(code ?? (signal === "SIGINT" ? 130 : 143)));
    });
  } finally { await lock.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runNode().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

import { spawn } from "node:child_process";

function duration(value, fallback) {
  if (!value) return fallback;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(value);
  if (!match) throw new Error("Build timeout must be a positive duration such as 180s or 3m");
  const milliseconds = Number(match[1]) * ({ ms: 1, s: 1000, m: 60000 }[match[2] ?? "s"]);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error("Build timeout must be positive");
  return milliseconds;
}

const executable = process.argv[2];
if (!executable) throw new Error("Usage: node scripts/run-bounded-build.mjs <executable> [arguments]");
const timeoutMs = duration(process.env.SITES_BUILD_TIMEOUT, 180000);
const killMs = duration(process.env.SITES_BUILD_KILL_AFTER, 10000);
let expired = false, killTimer;
const child = spawn(executable, process.argv.slice(3), { stdio: "inherit", detached: process.platform !== "win32" });
function stop(signal) {
  if (!child.pid) return;
  try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}
const timer = setTimeout(() => {
  expired = true; stop("SIGTERM");
  killTimer = setTimeout(() => stop("SIGKILL"), killMs);
}, timeoutMs);
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
child.on("error", error => { clearTimeout(timer); clearTimeout(killTimer); process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.on("exit", (code, signal) => { clearTimeout(timer); clearTimeout(killTimer); process.exitCode = expired ? 124 : code ?? (signal ? 1 : 0); });

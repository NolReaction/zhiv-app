import { totalmem } from "node:os";

const MIB = 1024 * 1024;
const HEAP_OPTION = /(?:^|\s)--max[-_]old[-_]space[-_]size(?:[-_]percentage)?(?:=|\s|$)/;

/** Leave room for native allocations, the OS and the test/build parent process. */
export function recommendedNodeHeapMb(totalBytes, constrainedBytes = 0) {
  const limits = [totalBytes, constrainedBytes].filter(value => Number.isFinite(value) && value > 0);
  const availableMb = Math.floor(Math.min(...limits) / MIB);
  return Math.max(256, Math.min(3584, Math.floor(availableMb * 0.6 / 128) * 128));
}

export function nodeMemoryEnvironment(env = process.env, limits = {}) {
  const nodeOptions = env.NODE_OPTIONS ?? "";
  // Explicit Node settings remain authoritative, including in child processes.
  if (HEAP_OPTION.test(nodeOptions)) return { env: { ...env }, heapMb: null, explicit: true };
  const override = env.ZHIV_NODE_HEAP_MB;
  if (override !== undefined && (!/^\d+$/.test(override) || Number(override) < 256 || Number(override) > 65536)) {
    throw new Error("ZHIV_NODE_HEAP_MB must be an integer between 256 and 65536 MiB");
  }
  const heapMb = override === undefined
    ? recommendedNodeHeapMb(limits.totalBytes ?? totalmem(), limits.constrainedBytes ?? process.constrainedMemory?.() ?? 0)
    : Number(override);
  return { env: { ...env, NODE_OPTIONS: `${nodeOptions} --max-old-space-size=${heapMb}`.trim() }, heapMb, explicit: override !== undefined };
}

export function boundedNodeArguments(args) {
  const result = [...args];
  if (result.includes("--test") && !result.some(arg => /^--test-concurrency(?:=|$)/.test(arg))) {
    result.unshift("--test-concurrency=1");
  }
  return result;
}

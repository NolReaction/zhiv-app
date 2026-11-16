import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, posix, resolve } from "node:path";

/** Catalog invalidation key, not a security signature. Keep the browser twin tested. */
export function progressionCatalogFingerprint(economy, rewards) {
  const value = JSON.stringify([economy, rewards]);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Capture before a run and compare afterward: later edits cannot certify old evidence. */
export async function progressionSourceDigests(root, { policyRoot = root } = {}) {
  async function files(directory) {
    const entries = await readdir(resolve(root, directory), { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(`${directory}/${entry.name}`)
      : entry.name.endsWith(".ts") ? [`${directory}/${entry.name}`] : []))).flat();
  }
  const paths = [...await files("features/economy/domain"),
    "features/game/progression-rewards.ts", "features/game/reward-catalog-compat.ts", "features/game/achievement-progress.ts",
    "features/mailbox/welcome.ts", "apps/api/src/main/resources/world/economy-catalog.json",
    "apps/api/src/main/resources/world/progression-rewards-catalog.json", "apps/api/src/main/resources/world/achievements-catalog.json",
    "apps/api/src/main/resources/world/collections-catalog.json", "apps/api/src/main/resources/world/neighbor-catalog.json",
    "lib/dev/api-store.ts", "lib/dev/economy-store.ts", "lib/dev/neighbor-store.ts", "scripts/simulate-economy-progression.mjs",
    "scripts/lib/economy-command-scenario.mjs", "scripts/lib/economy-reward-scenario.mjs", "scripts/audit-progression-scenarios.mjs",
  ];
  const helpers = await readdir(resolve(policyRoot, "scripts/lib"));
  for (const helper of ["economy-social-scenario.mjs", "economy-neighbor-scenario.mjs"]) if (helpers.includes(helper)) paths.push(`scripts/lib/${helper}`);
  // Market sensitivity executes the existing DEV transactions. Include their
  // local transitive imports (and referenced JSON), not only the facade file.
  // CSS/assets do not determine the economic result and are intentionally out.
  const sources = new Map(), queue = [...new Set(paths)];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const path = queue[cursor];
    if (sources.has(path)) continue;
    const bytes = await readFile(resolve(path.startsWith("scripts/") ? policyRoot : root, path));
    sources.set(path, bytes);
    if (!/\.(?:ts|tsx|mjs)$/.test(path)) continue;
    const imports = bytes.toString("utf8").matchAll(/\b(?:import|export)\s+(?:(?:[^;]*?)\s+from\s+)?["']([^"']+)["']/g);
    for (const [, specifier] of imports) {
      if (!specifier.startsWith("@/") && !specifier.startsWith(".")) continue;
      const base = specifier.startsWith("@/") ? specifier.slice(2) : posix.normalize(`${dirname(path)}/${specifier}`);
      if (extname(base) && !/\.(?:ts|tsx|mjs|json)$/.test(base)) continue;
      for (const candidate of extname(base) ? [base] : [`${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.json`, `${base}/index.ts`]) {
        if (sources.has(candidate) || queue.includes(candidate)) break;
        try { await readFile(resolve(candidate.startsWith("scripts/") ? policyRoot : root, candidate)); queue.push(candidate); break; }
        catch (error) { if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error; }
      }
    }
  }
  return Object.fromEntries([...sources.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) =>
    [path, createHash("sha256").update(bytes).digest("hex")]));
}

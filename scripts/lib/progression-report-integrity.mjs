import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

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
    "apps/api/src/main/resources/world/collections-catalog.json", "scripts/simulate-economy-progression.mjs",
    "scripts/lib/economy-command-scenario.mjs", "scripts/lib/economy-reward-scenario.mjs",
  ];
  const helpers = await readdir(resolve(policyRoot, "scripts/lib"));
  if (helpers.includes("economy-social-scenario.mjs")) paths.push("scripts/lib/economy-social-scenario.mjs");
  return Object.fromEntries(await Promise.all(paths.sort().map(async path => [path,
    createHash("sha256").update(await readFile(resolve(path.startsWith("scripts/") ? policyRoot : root, path))).digest("hex")])));
}

/** Invalidation key only. The report generator's twin is checked against this function. */
export function progressionCatalogFingerprint(economy: unknown, rewards: unknown) {
  const value = JSON.stringify([economy, rewards]);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

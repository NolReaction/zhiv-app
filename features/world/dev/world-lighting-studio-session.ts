/** Tiny lazy-entry handoff. No scene or account modules are loaded by the launchers. */
let pendingWorldStudio = false;
let owner: object | null = null;
export function requestWorldLightingStudioHandoff() { pendingWorldStudio = true; }
export function takeWorldLightingStudioHandoff() {
  const pending = pendingWorldStudio;
  pendingWorldStudio = false;
  return pending;
}
export function claimWorldLightingStudio(nextOwner: object) { owner = nextOwner; }
export function hasWorldLightingStudioOwner() { return owner !== null; }
/** A late cleanup from the home view cannot release the full map's owner. */
export function releaseWorldLightingStudio(previousOwner: object) {
  if (owner !== previousOwner) return false;
  owner = null;
  return true;
}

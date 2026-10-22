/** A server reset changes gameplay storage, never the account or its cookies.
 * The generation is fixed for this document: old tabs can only write old keys,
 * including their pagehide saves after a newer tab has already restarted. */
const NAMESPACE = "zhiv:gameplay:v1:";
export const GAMEPLAY_RESET_EVENT = "zhiv:game-progress-reset";
type ResetStorage = Pick<Storage, "length" | "key" | "getItem" | "removeItem">;

const accountPrefixes = [
  "zhiv.app-onboarding.v2:", "zhiv.app-onboarding.paused.v1:",
  "zhiv.world-onboarding.v1:", "zhiv.world-onboarding.paused.v1:",
  "zhiv.market-unlock-onboarding.v1:", "zhiv.section-guide.launcher.v1:",
  "zhiv.miner-arrival.v1:", "zhiv.leaftail-arrival.v1:", "zhiv.lopukh-arrival.v1:",
  "zhiv.world.tap-hints.v1:", "zhiv.earth-atlas.v1:",
  "zhiv:game-outbox:v1:", "zhiv:game-writer:v1:", "zhiv:game-rewards:pending:v1:",
  "zhiv:economy:production:v1:", "zhiv:economy:pending:v1:", "zhiv:world:pending:v1:",
  "zhiv:construction-goal:v1:", "zhiv:pending-promo:v1:", "zhiv:mochlik:presence:",
  "zhiv.clicker-progress.v1:", "zhiv.clicker-progress.v2:", "zhiv.clicker-progress.v3:", "zhiv.clicker-archive.v054:",
];
function belongsToAccount(key: string, owner: string, storage: ResetStorage, actualKey: string) {
  const encoded = encodeURIComponent(owner);
  if (accountPrefixes.some(prefix => key === `${prefix}${owner}` || key === `${prefix}${encoded}`)
    || key.startsWith(`zhiv:game-input:v1:${owner}:`)
    || key.startsWith(`zhiv.onboarding-replay.v1:${owner}:`)
    || key.startsWith(`zhiv.section-guide.v1:${encoded}:`)
    || key === `zhiv:forest-memory:v1:${encodeURIComponent(`zhiv:mochlik:presence:${owner}`)}`) return true;
  if (key === "zhiv.pending-check-in.v1" || key === "zhiv.pending-check-in.v2") {
    try { return JSON.parse(storage.getItem(actualKey) ?? "null")?.ownerPublicId === owner; } catch { return true; }
  }
  return false;
}

/** Best-effort disposal only. Namespacing, not successful deletion, prevents replay. */
export function clearPreviousGameplayStorage(storage: ResetStorage, owner: string, generation: number) {
  if (generation === 0) return;
  try {
    const remove: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key) continue;
      let original = key;
      if (key.startsWith(NAMESPACE)) {
        const match = /^([0-9]+):(.*)$/.exec(key.slice(NAMESPACE.length));
        if (!match || Number(match[1]) >= generation) continue;
        original = match[2];
      }
      if (belongsToAccount(original, owner, storage, key)) remove.push(key);
    }
    for (const key of remove) storage.removeItem(key);
  } catch { /* A blocked store cannot expose an old generation through its new keys. */ }
}

export function createGameplayGeneration() {
  let generation: number | null = null;
  let blocked = false;
  return {
    adopt(owner: string, next: number, storages: readonly ResetStorage[] = []) {
      if (!Number.isSafeInteger(next) || next < 0) throw new Error("Invalid gameplay generation");
      if (blocked || generation !== null && generation !== next) { blocked = true; return false; }
      generation = next;
      for (const storage of storages) clearPreviousGameplayStorage(storage, owner, next);
      return true;
    },
    key(key: string) { return generation ? `${NAMESPACE}${generation}:${key}` : key; },
    headers(): Record<string, string> { return { "X-Game-Generation": String(generation ?? 0) }; },
    reject(code: unknown, sent: Record<string, string>) {
      if (code !== "GAME_PROGRESS_RESET" || blocked || sent["X-Game-Generation"] !== String(generation ?? 0)) return false;
      blocked = true;
      return true;
    },
    isBlocked: () => blocked,
  };
}

const current = createGameplayGeneration();
export const gameplayStorageKey = current.key;
export const gameplayGenerationHeaders = current.headers;
export const gameplayResetPending = current.isBlocked;
export function prepareGameplayGeneration(owner: string, generation: number) {
  const storages: ResetStorage[] = [];
  if (typeof window !== "undefined") {
    try { storages.push(window.localStorage); } catch { /* Optional browser cache. */ }
    try { storages.push(window.sessionStorage); } catch { /* Optional browser cache. */ }
  }
  return current.adopt(owner, generation, storages);
}
export function reportGameplayReset(code: unknown, sent: Record<string, string>) {
  if (current.reject(code, sent) && typeof window !== "undefined") window.dispatchEvent(new Event(GAMEPLAY_RESET_EVENT));
}

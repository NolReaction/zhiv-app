import type { FixedWorldScene, WorldPoint } from "./tiled/types";
import type { ForestSessionState } from "./forest-session";
import { isWalkable } from "./navigation";
import { CLEARING_AWAKE_GRACE_SECONDS, requestClearingSleep } from "./clearing-activity";
import { restoreForestMind } from "./forest-mind";

export type ForestMemoryStatus = {
  mode: "local" | "ephemeral" | "unavailable";
  restored: boolean; reconciled: boolean; lastSavedAt: number | null; enabled: boolean;
};
export type ForestMemoryEnvironment = {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  now: () => number;
  /** Save on pagehide and when the document becomes hidden. Bound once per shared session. */
  onLifecycleSave?: (save: () => void) => () => void;
};
type MemoryState = Pick<ForestSessionState, "clearing" | "life">;
type JsonObject = Record<string, unknown>;
const VERSION = 1, MAX_BYTES = 32_768, SAVE_INTERVAL_MS = 10_000, MAX_TIMESTAMP = 8_640_000_000_000_000;
const fingerprints = new WeakMap<FixedWorldScene, string>();
const object = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const bounded = (value: unknown, lo: number, hi: number, fallback = lo) => finite(value) ? Math.min(hi, Math.max(lo, value)) : fallback;
const point = (value: unknown): value is WorldPoint => object(value) && finite(value.x) && finite(value.y);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 160;
const samePoint = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y) < .001;

export function forestMemoryKey(account: string) { return `zhiv:forest-memory:v${VERSION}:${encodeURIComponent(account)}`; }

/** A geometry edit invalidates feet and old landmarks, without resetting the pet's needs. */
export function forestSceneFingerprint(scene: FixedWorldScene): string {
  const cached = fingerprints.get(scene); if (cached) return cached;
  const input = JSON.stringify({ id: scene.id, width: scene.width, height: scene.height, focus: scene.focus,
    actor: scene.actor, navigation: scene.navigation, sites: scene.sites.map(site => ({ id: site.id,
      entry: site.entry, doorway: site.doorway, collision: site.collision })), paths: scene.paths,
    bushes: scene.bushes, mushrooms: scene.mushrooms, habitats: scene.habitats, water: scene.water?.surfaces });
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) hash = Math.imul(hash ^ input.charCodeAt(index), 16777619);
  const fingerprint = `${input.length.toString(36)}-${(hash >>> 0).toString(36)}`;
  fingerprints.set(scene, fingerprint); return fingerprint;
}

export function browserForestMemoryEnvironment(): ForestMemoryEnvironment | null {
  if (typeof window === "undefined") return null;
  // Access to localStorage itself can throw in private/embedded contexts.
  try {
    const storage = window.localStorage;
    if (!storage) return null;
    return { storage: {
      getItem: key => storage.getItem(key), setItem: (key, value) => storage.setItem(key, value), removeItem: key => storage.removeItem(key),
    }, now: () => Date.now(), onLifecycleSave(save) {
      const hidden = () => { if (document.visibilityState === "hidden") save(); };
      window.addEventListener("pagehide", save); document.addEventListener("visibilitychange", hidden);
      return () => { window.removeEventListener("pagehide", save); document.removeEventListener("visibilitychange", hidden); };
    } };
  } catch { return null; }
}

function safeOutdoorPosition(state: MemoryState, desired: unknown): WorldPoint {
  const clearing = state.clearing;
  // Legacy maps can only resume at their authored spawn; arbitrary saved feet require WalkAreas.
  if (point(desired) && clearing.navigation && isWalkable(clearing.navigation, desired)) return { ...desired };
  return { ...clearing.home };
}

function stablePosition(state: MemoryState): WorldPoint {
  const clearing = state.clearing;
  if (clearing.navigation && isWalkable(clearing.navigation, clearing.position)) return { ...clearing.position };
  const interaction = clearing.activeInteraction;
  const authored = interaction?.kind === "home" ? clearing.interactions.home
    : clearing.interactions.bushes.find(bush => bush.id === interaction?.route.bush?.id
      || bush.id === clearing.routes[clearing.routeIndex]?.bush?.id);
  return safeOutdoorPosition(state, authored?.dock);
}

function snapshot(state: MemoryState, account: string, scene: FixedWorldScene, savedAt: number) {
  const clearing = state.clearing, mind = clearing.behavior.mind;
  const carrying = state.life.routine?.kind === "mushroom" && state.life.routine.picked && state.life.routine.elapsed < 4.1
    ? state.life.routine.mushroomId : null;
  return { version: VERSION, account, sceneId: scene.id, fingerprint: forestSceneFingerprint(scene), savedAt,
    // Decisions, encounter tokens, path graphs and frame clocks are deliberately absent.
    mind: { elapsed: mind.elapsed, needs: { ...mind.needs }, recent: mind.recent.slice(-16), attentionUntil: mind.attentionUntil },
    hero: { position: stablePosition(state), sleepingHome: clearing.stage === "home-sleep",
      awakeFor: bounded(clearing.awakeUntil - clearing.elapsed, 0, CLEARING_AWAKE_GRACE_SECONDS),
      restFor: bounded(clearing.behavior.restUntil - clearing.elapsed, 0, 45),
      recent: clearing.behavior.recent.slice(-8).map(item => ({ id: item.id, activity: item.activity,
        age: bounded(clearing.elapsed - item.at, 0, 75) })) },
    mushrooms: state.life.mushrooms.slice(0, 128).map(mushroom => ({ id: mushroom.id, position: { x: mushroom.x, y: mushroom.y },
      // An unbitten carried prop is put back; bitten food keeps its existing regrowth timer.
      growth: mushroom.id === carrying ? 1 : bounded(mushroom.growth, 0, 1),
      regrowIn: mushroom.id === carrying ? 0 : bounded(mushroom.regrowIn, 0, 22) })),
  };
}

function restoreHomeSleep(state: MemoryState): boolean {
  const clearing = state.clearing;
  // Rebuild a validated current home connector; never deserialize old routes/door geometry.
  if (!requestClearingSleep(clearing)) return false;
  const route = clearing.activeInteraction?.kind === "home" ? clearing.activeInteraction.route : clearing.homeRoute;
  if (!route || !clearing.doorway) return false;
  clearing.stage = "home-sleep"; clearing.stageElapsed = 0; clearing.routeKind = "home";
  clearing.position = { ...clearing.doorway }; clearing.distance = route.length; clearing.speed = 0;
  clearing.doorProgress = 1; clearing.homeEnabled = true; clearing.retiring = true;
  clearing.steps = []; clearing.freeRoute = null; clearing.freePurpose = null;
  return true;
}

function restore(state: MemoryState, account: string, scene: FixedWorldScene, raw: string): { savedAt: number; reconciled: boolean } | null {
  if (raw.length > MAX_BYTES) return null;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!object(data) || data.version !== VERSION || data.account !== account || data.sceneId !== scene.id
    || !text(data.fingerprint) || !finite(data.savedAt) || data.savedAt < 0 || data.savedAt > MAX_TIMESTAMP || !object(data.mind)
    || !object(data.mind.needs) || !object(data.hero) || !Array.isArray(data.mushrooms)
    || data.mushrooms.length > 128) return null;
  const reconciled = data.fingerprint !== forestSceneFingerprint(scene), clearing = state.clearing;
  clearing.behavior.mind = restoreForestMind(reconciled ? { needs: data.mind.needs } : data.mind);
  if (!reconciled) {
    clearing.position = safeOutdoorPosition(state, data.hero.position);
    clearing.stage = samePoint(clearing.position, clearing.home) ? "home" : "clearing";
    clearing.awakeUntil = bounded(data.hero.awakeFor, 0, CLEARING_AWAKE_GRACE_SECONDS);
    clearing.behavior.restUntil = bounded(data.hero.restFor, 0, 45);
    const activities = new Set(["look", "sniff", "groom", "rest"]), ids = new Set(clearing.interests.map(interest => interest.id));
    if (Array.isArray(data.hero.recent)) for (const recent of data.hero.recent.slice(-8)) {
      if (!object(recent) || !text(recent.id) || typeof recent.activity !== "string" || !activities.has(recent.activity)
        || !finite(recent.age) || recent.age < 0 || recent.age > 75 || !ids.has(recent.id) && !/^grass--?\d+--?\d+$/.test(recent.id)) continue;
      clearing.behavior.recent.push({ id: recent.id, activity: recent.activity as "look" | "sniff" | "groom" | "rest", at: -recent.age });
    }
    if (data.hero.sleepingHome === true) restoreHomeSleep(state);
  }
  // The map remains authoritative, including moved/removed mushrooms and their reachability.
  for (const mushroom of state.life.mushrooms) {
    const remembered = data.mushrooms.find(item => object(item) && item.id === mushroom.id
      && point(item.position) && samePoint(item.position, mushroom));
    if (!object(remembered)) continue;
    mushroom.growth = bounded(remembered.growth, 0, 1, mushroom.growth);
    mushroom.regrowIn = bounded(remembered.regrowIn, 0, 22);
  }
  // No clock catch-up or resumed encounter: absence never drains needs or grows rewards.
  clearing.behavior.mind.intention = null; clearing.behavior.mind.candidates = [];
  return { savedAt: data.savedAt, reconciled };
}

/** Per-account local visual memory. No API calls, currency, inventory or rewards are stored. */
export function createForestMemory(account: string | undefined, scene: FixedWorldScene, state: MemoryState,
  options: { persistence?: boolean; environment?: ForestMemoryEnvironment | null } = {}) {
  const eligible = text(account) && options.persistence !== false;
  const environment = eligible ? options.environment === undefined ? browserForestMemoryEnvironment() : options.environment : null;
  const status: ForestMemoryStatus = { mode: !eligible ? "ephemeral" : environment ? "local" : "unavailable",
    restored: false, reconciled: false, lastSavedAt: null, enabled: Boolean(eligible && environment) };
  const key = eligible ? forestMemoryKey(account) : null;
  let lastAttempt = environment?.now() ?? 0, disposed = false;
  const unavailable = () => { status.mode = "unavailable"; status.enabled = false; };
  if (key && environment) try {
    const raw = environment.storage.getItem(key), result = raw ? restore(state, account!, scene, raw) : null;
    if (result) { status.restored = true; status.reconciled = result.reconciled; status.lastSavedAt = result.savedAt; }
  } catch { unavailable(); }
  function save() {
    if (disposed || !key || !environment || !status.enabled) return;
    try {
      const now = environment.now(); if (!finite(now) || now < 0 || now > MAX_TIMESTAMP) return;
      lastAttempt = now;
      const raw = JSON.stringify(snapshot(state, account!, scene, now));
      if (raw.length > MAX_BYTES) return;
      environment.storage.setItem(key, raw); status.lastSavedAt = now;
    } catch { unavailable(); }
  }
  let unsubscribe = () => {};
  if (status.enabled && environment?.onLifecycleSave) try { unsubscribe = environment.onLifecycleSave(save); } catch { /* Optional lifecycle hooks. */ }
  return { status,
    pulse(active: boolean) {
      if (!active || !status.enabled || !environment || disposed) return;
      const now = environment.now();
      if (now - lastAttempt >= SAVE_INTERVAL_MS || now < lastAttempt) save();
    },
    save,
    suspend() { if (!disposed && status.enabled) { save(); status.enabled = false; status.mode = "ephemeral"; } },
    reset() {
      if (disposed || !key || !environment) return;
      try { environment.storage.removeItem(key); status.restored = false; status.reconciled = false; status.lastSavedAt = null;
        status.enabled = false; status.mode = "ephemeral";
      } catch { unavailable(); }
    },
    release() { if (disposed) return; save(); disposed = true; unsubscribe(); },
  };
}

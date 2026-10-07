import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import type { FixedWorldScene } from "./tiled/types";
import { createForestLife } from "./forest-life";
import { createClearingActivity, setClearingNavigationObstacle } from "./clearing-activity";
import { gardenBasketFootprint } from "./forest-garden";
import { createForestSocial } from "./forest-social";
import { createForestFauna } from "./forest-fauna";
import { createForestDirector, type ForestDirective } from "./forest-director";
import { createBirdReactions } from "./forest-bird-reactions";
import { createForestMemory, forestSceneFingerprint, type ForestMemoryEnvironment, type ForestMemoryStatus } from "./forest-memory";
import { forgetForestObservation } from "./forest-observer";
import { createForestMemorySync, type ForestMemorySyncEnvironment, type ForestMemoryTransport } from "./forest-memory-sync";
import { createPleskMind, type PleskMind } from "./plesk-mind";
import { createBuilderMind, rehydrateBuilderMind, type BuilderMind } from "./builder-mind";
import type { EconomySceneConstruction } from "./economy-construction-state";
import type { ForestJourneyTravel } from "./forest-journey-travel";
import type { EconomySceneProduction } from "./economy-production-state";

type View = "circle" | "world";
type Member = { view: View; active: boolean; retain: boolean; changed: (ownerChanged: boolean) => void };
export type ForestSessionState = {
  memory: ForestMemoryStatus;
  elapsed: number; timestamp: number; dusk: number; wetness: number;
  life: ReturnType<typeof createForestLife>;
  clearing: ReturnType<typeof createClearingActivity>;
  fauna: ReturnType<typeof createForestFauna>;
  director: ReturnType<typeof createForestDirector>;
  social: ReturnType<typeof createForestSocial>;
  /** Resident autonomy shares the visible session clock, never economic inventory. */
  pleskMind: PleskMind | null;
  builderMind: BuilderMind | null;
  economyConstruction?: EconomySceneConstruction;
  birdReactions: ReturnType<typeof createBirdReactions>;
  lastBirdStimulus: number;
  pendingLife: ForestDirective | null;
  pendingAttention: boolean;
  /** Transient display state only; economic jobs are restored from the economy API. */
  explorationId?: string | null;
  /** Latest confirmed production revision; transient and never saved as forest memory. */
  economyProduction?: EconomySceneProduction;
  /** Shared cosmetic departure/return; deliberately omitted from saved memory. */
  journeyTravel?: ForestJourneyTravel;
  /** Isolated DEV playback clocks; never included in forest memory. */
  residentPreview?: { id: number; startedAt: number };
  builderPreview?: { id: number; startedAt: number };
  fishingPreview?: { id: number; startedAt: number };
  cookingPreview?: { id: number; startedAt: number | null; requestedAt: number; attentionAt?: number };
  reaction: number; animation: { pose: PixelPose; elapsed: number } | null; birdStarted: number | null; birdSeed: number;
};
type Session = { state: ForestSessionState; memory: ReturnType<typeof createForestMemory>;
  key: string | undefined; sync?: ReturnType<typeof createForestMemorySync>; removeLifecycle?: () => void;
  members: Set<Member>; owner: Member | null; events: Map<string, number>; controls?: object; visibleHandoff?: boolean; retained?: boolean; retentionBlocked?: boolean };
const sessions = new Map<string, Session>();

function discardSession(identity: string | undefined, session: Session) {
  session.sync?.release(); session.removeLifecycle?.(); session.memory.release();
  if (identity !== undefined && sessions.get(identity) === session) sessions.delete(identity);
  if (![...sessions.values()].some(other => other.key === session.key)) forgetForestObservation(session.key);
}

/** Account logout/replacement invalidates even a canvas whose cleanup runs later. */
export function forgetForestSession(key: string | undefined) {
  if (!key) return;
  for (const [identity, session] of sessions) if (session.key === key) {
    session.retentionBlocked = true;
    if (!session.members.size) discardSession(identity, session);
  }
}

export type ForestSessionOptions = { persistence?: boolean; environment?: ForestMemoryEnvironment | null;
  /** Real account scenes wait for their first confirmed economic snapshot. */
  awaitBuilderConstruction?: boolean;
  sync?: false | { transport?: ForestMemoryTransport; environment?: ForestMemorySyncEnvironment } };

/** UI takeover always targets the existing account session, never a new writer. */
export function takeOverForestSession(key: string | undefined) {
  if (!key) return;
  for (const session of sessions.values()) if (session.key === key) session.sync?.takeOver();
}

/** One clock per account; a server lease elects its writer across devices and tabs. */
export function connectForestSession(key: string | undefined, scene: FixedWorldScene, view: View,
  timestamp: number, dusk: number, changed: Member["changed"],
  options: ForestSessionOptions = {}) {
  const identity = key ? `account:${key}:${forestSceneFingerprint(scene)}` : undefined;
  // Keep at most one unmounted forest, and never reuse another account's or
  // another map geometry's parked routes. Mounted views still share as before.
  for (const [parkedIdentity, parked] of sessions) if (!parked.members.size && parkedIdentity !== identity) {
    discardSession(parkedIdentity, parked);
  }
  let shared = identity === undefined ? undefined : sessions.get(identity);
  if (!shared) {
    const state: ForestSessionState = { elapsed: 0, timestamp, dusk, wetness: 0, life: createForestLife(scene), clearing: createClearingActivity(scene),
      social: createForestSocial(`${key ?? "guest"}:${timestamp}`), fauna: createForestFauna(scene), pleskMind: createPleskMind(scene), builderMind: createBuilderMind(scene, { awaitConstruction: options.awaitBuilderConstruction }), director: createForestDirector(), birdReactions: createBirdReactions(), lastBirdStimulus: 0,
      pendingLife: null, pendingAttention: false,
      reaction: 0, animation: null, birdStarted: null, birdSeed: -1,
      memory: { mode: "ephemeral", restored: false, reconciled: false, lastSavedAt: null, enabled: false } };
    // A remembered outdoor position must also be clear of the parked basket.
    setClearingNavigationObstacle(state.clearing, gardenBasketFootprint(state.life.garden));
    const memory = createForestMemory(key, scene, state, options);
    state.memory = memory.status;
    shared = { key, state, memory, members: new Set(), owner: null, events: new Map() };
    const ownerPublicId = key?.replace(/^zhiv:mochlik:presence:/, "");
    if (options.persistence !== false && options.sync !== false && ownerPublicId
      && /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/.test(ownerPublicId)
      && (typeof window !== "undefined" || options.sync)) {
      const current = shared;
      current.sync = createForestMemorySync({ ownerPublicId, ...options.sync,
        capture: memory.capture,
        apply(payload) {
          // Hydration starts at a safe state: no old paths, encounter participants or forced animations survive it.
          Object.assign(state, { elapsed: 0, wetness: 0, clearing: createClearingActivity(scene), life: createForestLife(scene),
            social: createForestSocial(`${key ?? "guest"}:${timestamp}`), fauna: createForestFauna(scene), pleskMind: createPleskMind(scene), builderMind: rehydrateBuilderMind(scene, state.builderMind), director: createForestDirector(), birdReactions: createBirdReactions(),
            lastBirdStimulus: 0, pendingLife: null, pendingAttention: false, explorationId: undefined, journeyTravel: undefined, cookingPreview: undefined, builderPreview: undefined, reaction: 0, animation: null,
            birdStarted: null, birdSeed: -1 });
          setClearingNavigationObstacle(state.clearing, gardenBasketFootprint(state.life.garden));
          memory.apply(payload);
        },
        onStatus(status) {
          state.memory.sync = status;
          queueMicrotask(() => { for (const item of current.members) item.changed(true); });
        },
      });
      state.memory.sync = current.sync.getStatus();
    }
    if (typeof window !== "undefined") {
      const current = shared;
      const leave = () => {
        current.visibleHandoff = false; current.retained = false;
        if (!current.members.size) discardSession(identity, current);
        else current.sync?.setActive(false);
      };
      const resume = () => current.sync?.setActive(current.owner !== null && !document.hidden);
      // With no canvas mounted there is no renderer visibility listener. A
      // parked session has already released the lease; pagehide discards it.
      window.addEventListener("pagehide", leave); window.addEventListener("pageshow", resume);
      current.removeLifecycle = () => { window.removeEventListener("pagehide", leave); window.removeEventListener("pageshow", resume); };
    }
    if (identity !== undefined) sessions.set(identity, shared);
  }
  // DEV settings can change between mounting the circle and opening the map. They
  // suspend the shared account session; they must never create a second clock.
  if (options.persistence === false) { shared.retentionBlocked = true; shared.sync?.suspend(); shared.memory.suspend(); }
  const session = shared, member: Member = { view, active: false, retain: false, changed };
  let disposed = false;
  function select() {
    const eligible = [...session.members].filter(item => item.active);
    const next = eligible.find(item => item.view === "world") ?? eligible[0] ?? null;
    const previous = session.owner, visible = typeof document === "undefined" || !document.hidden;
    const parked = !session.retentionBlocked && (session.retained || [...session.members].some(item => item.retain));
    const preserveLiveScene = Boolean(parked || next && visible && (previous || session.visibleHandoff));
    session.visibleHandoff = !next && Boolean(parked || visible && (previous || session.visibleHandoff));
    session.owner = next;
    session.sync?.setActive(next !== null && visible, preserveLiveScene);
    if (next === previous) return;
    // Ownership is immediate; loop changes are deferred until newly mounted handles exist.
    queueMicrotask(() => { for (const item of session.members) item.changed(true); });
  }
  session.members.add(member);
  return {
    state: session.state,
    isOwner: () => !disposed && session.owner === member && (session.sync?.isSimulationAllowed() ?? true),
    isSimulationAllowed: () => !disposed && (session.sync?.isSimulationAllowed() ?? true),
    isObservationOwner: () => !disposed && (session.owner === member || session.owner === null),
    configure(nextView: View, active: boolean, retainPausedScene = false) {
      if (disposed) return;
      member.view = nextView; member.active = active; member.retain = retainPausedScene;
      select();
    },
    consumeControls(snapshot: object) {
      if (disposed || session.controls === snapshot) return false;
      session.controls = snapshot; return true;
    },
    consumeEvent(channel: string, id: number) {
      if (disposed || !Number.isFinite(id) || id <= (session.events.get(channel) ?? 0)) return false;
      session.events.set(channel, id); return true;
    },
    publish() {
      if (disposed) return;
      session.memory.pulse(session.owner !== null);
      for (const item of session.members) item.changed(false);
    },
    /** Call before the first forced DEV action. A later reset of controls cannot save that altered simulation. */
    suspendPersistence() { if (!disposed) { session.retentionBlocked = true; session.sync?.suspend(); session.memory.suspend(); } },
    saveMemory() { if (!disposed) { session.memory.save(); session.sync?.flush(); } },
    resetMemory() { if (!disposed) { session.retentionBlocked = true; session.sync?.suspend(); session.memory.reset(); } },
    takeOverMemory() { if (!disposed) session.sync?.takeOver(); },
    release(options: { retain?: boolean } = {}) {
      if (disposed) return;
      session.retained = Boolean(options.retain && identity && !session.retentionBlocked);
      disposed = true; session.members.delete(member); select();
      if (!session.members.size) {
        if (session.retained) {
          session.memory.save();
          for (const [otherIdentity, other] of sessions) if (other !== session && !other.members.size) discardSession(otherIdentity, other);
        } else discardSession(identity, session);
      }
    },
  };
}

import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import type { FixedWorldScene } from "./tiled/types";
import { createForestLife } from "./forest-life";
import { createClearingActivity } from "./clearing-activity";
import { createForestFauna } from "./forest-fauna";
import { createForestDirector, type ForestDirective } from "./forest-director";
import { createBirdReactions } from "./forest-bird-reactions";
import { createForestMemory, forestSceneFingerprint, type ForestMemoryEnvironment, type ForestMemoryStatus } from "./forest-memory";
import { forgetForestObservation } from "./forest-observer";
import { createForestMemorySync, type ForestMemorySyncEnvironment, type ForestMemoryTransport } from "./forest-memory-sync";

type View = "circle" | "world";
type Member = { view: View; active: boolean; changed: (ownerChanged: boolean) => void };
export type ForestSessionState = {
  memory: ForestMemoryStatus;
  elapsed: number; timestamp: number; dusk: number; wetness: number;
  life: ReturnType<typeof createForestLife>;
  clearing: ReturnType<typeof createClearingActivity>;
  fauna: ReturnType<typeof createForestFauna>;
  director: ReturnType<typeof createForestDirector>;
  birdReactions: ReturnType<typeof createBirdReactions>;
  lastBirdStimulus: number;
  pendingLife: ForestDirective | null;
  pendingAttention: boolean;
  reaction: number; animation: { pose: PixelPose; elapsed: number } | null; birdStarted: number | null; birdSeed: number;
};
type Session = { state: ForestSessionState; memory: ReturnType<typeof createForestMemory>;
  key: string | undefined; sync?: ReturnType<typeof createForestMemorySync>; removeLifecycle?: () => void;
  members: Set<Member>; owner: Member | null; events: Map<string, number>; controls?: object };
const sessions = new Map<string, Session>();

export type ForestSessionOptions = { persistence?: boolean; environment?: ForestMemoryEnvironment | null;
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
  let shared = identity === undefined ? undefined : sessions.get(identity);
  if (!shared) {
    const state: ForestSessionState = { elapsed: 0, timestamp, dusk, wetness: 0, life: createForestLife(scene), clearing: createClearingActivity(scene),
      fauna: createForestFauna(scene), director: createForestDirector(), birdReactions: createBirdReactions(), lastBirdStimulus: 0,
      pendingLife: null, pendingAttention: false,
      reaction: 0, animation: null, birdStarted: null, birdSeed: -1,
      memory: { mode: "ephemeral", restored: false, reconciled: false, lastSavedAt: null, enabled: false } };
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
            fauna: createForestFauna(scene), director: createForestDirector(), birdReactions: createBirdReactions(),
            lastBirdStimulus: 0, pendingLife: null, pendingAttention: false, reaction: 0, animation: null,
            birdStarted: null, birdSeed: -1 });
          memory.apply(payload);
        },
        onStatus(status) {
          state.memory.sync = status;
          queueMicrotask(() => { for (const item of current.members) item.changed(true); });
        },
      });
      state.memory.sync = current.sync.getStatus();
      if (typeof window !== "undefined") {
        const leave = () => current.sync?.setActive(false);
        const resume = () => current.sync?.setActive(current.owner !== null && !document.hidden);
        window.addEventListener("pagehide", leave); window.addEventListener("pageshow", resume);
        current.removeLifecycle = () => { window.removeEventListener("pagehide", leave); window.removeEventListener("pageshow", resume); };
      }
    }
    if (identity !== undefined) sessions.set(identity, shared);
  }
  // DEV settings can change between mounting the circle and opening the map. They
  // suspend the shared account session; they must never create a second clock.
  if (options.persistence === false) { shared.sync?.suspend(); shared.memory.suspend(); }
  const session = shared, member: Member = { view, active: false, changed };
  let disposed = false;
  function select() {
    const eligible = [...session.members].filter(item => item.active);
    const next = eligible.find(item => item.view === "world") ?? eligible[0] ?? null;
    if (next === session.owner) return;
    session.owner = next;
    session.sync?.setActive(next !== null && (typeof document === "undefined" || !document.hidden));
    // Ownership is immediate; loop changes are deferred until newly mounted handles exist.
    queueMicrotask(() => { for (const item of session.members) item.changed(true); });
  }
  session.members.add(member);
  return {
    state: session.state,
    isOwner: () => !disposed && session.owner === member && (session.sync?.isSimulationAllowed() ?? true),
    isSimulationAllowed: () => !disposed && (session.sync?.isSimulationAllowed() ?? true),
    isObservationOwner: () => !disposed && (session.owner === member || session.owner === null),
    configure(nextView: View, active: boolean) {
      if (disposed) return;
      member.view = nextView; member.active = active; select();
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
    suspendPersistence() { if (!disposed) { session.sync?.suspend(); session.memory.suspend(); } },
    saveMemory() { if (!disposed) { session.memory.save(); session.sync?.flush(); } },
    resetMemory() { if (!disposed) { session.sync?.suspend(); session.memory.reset(); } },
    takeOverMemory() { if (!disposed) session.sync?.takeOver(); },
    release() {
      if (disposed) return;
      disposed = true; session.members.delete(member); select();
      if (!session.members.size) {
        session.sync?.release(); session.removeLifecycle?.(); session.memory.release();
        if (identity !== undefined) sessions.delete(identity);
        forgetForestObservation(key);
      }
    },
  };
}

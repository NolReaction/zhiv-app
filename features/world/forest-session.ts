import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import type { FixedWorldScene } from "./tiled/types";
import { createForestLife } from "./forest-life";
import { createClearingActivity } from "./clearing-activity";
import { createForestFauna } from "./forest-fauna";
import { createForestDirector, type ForestDirective } from "./forest-director";
import { createBirdReactions } from "./forest-bird-reactions";
import { createForestMemory, forestSceneFingerprint, type ForestMemoryEnvironment, type ForestMemoryStatus } from "./forest-memory";
import { forgetForestObservation } from "./forest-observer";

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
  members: Set<Member>; owner: Member | null; events: Map<string, number>; controls?: object };
const sessions = new Map<string, Session>();

/** One clock and local memory per account, with an art-ready world taking priority over its circle. */
export function connectForestSession(key: string | undefined, scene: FixedWorldScene, view: View,
  timestamp: number, dusk: number, changed: Member["changed"],
  options: { persistence?: boolean; environment?: ForestMemoryEnvironment | null } = {}) {
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
    shared = { state, memory, members: new Set(), owner: null, events: new Map() };
    if (identity !== undefined) sessions.set(identity, shared);
  }
  const session = shared, member: Member = { view, active: false, changed };
  let disposed = false;
  function select() {
    const eligible = [...session.members].filter(item => item.active);
    const next = eligible.find(item => item.view === "world") ?? eligible[0] ?? null;
    if (next === session.owner) return;
    session.owner = next;
    // Ownership is immediate; loop changes are deferred until newly mounted handles exist.
    queueMicrotask(() => { for (const item of session.members) item.changed(true); });
  }
  session.members.add(member);
  return {
    state: session.state,
    isOwner: () => !disposed && session.owner === member,
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
    suspendPersistence() { if (!disposed) session.memory.suspend(); },
    saveMemory() { if (!disposed) session.memory.save(); },
    resetMemory() { if (!disposed) session.memory.reset(); },
    release() {
      if (disposed) return;
      disposed = true; session.members.delete(member); select();
      if (!session.members.size) {
        session.memory.release();
        if (identity !== undefined) sessions.delete(identity);
        forgetForestObservation(key);
      }
    },
  };
}

import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import type { FixedWorldScene } from "./tiled/types";
import { createForestLife, type ForestLifeAction } from "./forest-life";
import { createClearingActivity } from "./clearing-activity";

type View = "circle" | "world";
type Member = { view: View; active: boolean; changed: (ownerChanged: boolean) => void };
export type ForestSessionState = {
  elapsed: number; timestamp: number; dusk: number; wetness: number;
  life: ReturnType<typeof createForestLife>;
  clearing: ReturnType<typeof createClearingActivity>;
  pendingLife: ForestLifeAction | null;
  pendingAttention: boolean;
  reaction: number; animation: { pose: PixelPose; elapsed: number } | null; birdStarted: number | null; birdSeed: number;
};
type Session = { state: ForestSessionState; members: Set<Member>; owner: Member | null; events: Map<string, number>; controls?: object };
const sessions = new Map<string, Session>();

/** One ephemeral clock per account, with an art-ready world taking priority over its circle. */
export function connectForestSession(key: string | undefined, scene: FixedWorldScene, view: View,
  timestamp: number, dusk: number, changed: Member["changed"]) {
  const identity = key === undefined ? undefined : `account:${key}`;
  let shared = identity === undefined ? undefined : sessions.get(identity);
  if (!shared) {
    shared = { state: { elapsed: 0, timestamp, dusk, wetness: 0, life: createForestLife(scene), clearing: createClearingActivity(scene), pendingLife: null, pendingAttention: false,
      reaction: 0, animation: null, birdStarted: null, birdSeed: -1 }, members: new Set(), owner: null, events: new Map() };
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
    publish() { if (!disposed) for (const item of session.members) item.changed(false); },
    release() {
      if (disposed) return;
      disposed = true; session.members.delete(member); select();
      if (!session.members.size && identity !== undefined) sessions.delete(identity);
    },
  };
}

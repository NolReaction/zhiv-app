import { createHabitat } from "./habitat";

type View = "circle" | "world";
type Member = { view: View; active: boolean; changed: () => void };
type Session = { world: ReturnType<typeof createHabitat>; members: Set<Member>; owner: Member | null; clock: number };
const sessions = new Map<string, Session>();

/** One local choreography per account; canvases never share progression authority. */
export function connectHabitat(key: string | undefined, view: View, active: boolean,
  initialize: (world: ReturnType<typeof createHabitat>) => void, changed: () => void, now = Date.now()) {
  const identity = key ?? `anonymous:${++anonymous}`;
  let shared = sessions.get(identity);
  if (!shared) {
    const world = createHabitat(); initialize(world);
    shared = { world, members: new Set(), owner: null, clock: now }; sessions.set(identity, shared);
  }
  const session = shared;
  const member: Member = { view, active, changed };
  let disposed = false;
  function select() {
    const eligible = [...session.members].filter(item => item.active);
    const next = eligible.find(item => item.view === "world") ?? eligible[0] ?? null;
    session.world.setEngaged(next?.view === "world");
    if (session.owner === next) return;
    session.owner = next;
    // Notifications may resume scene loops, so avoid calling a half-created handle.
    queueMicrotask(() => { for (const item of session.members) item.changed(); });
  }
  session.members.add(member); select();
  return {
    world: session.world,
    isOwner: () => !disposed && session.owner === member,
    unattendedFor: (at: number) => session.owner ? 0 : Math.max(0, (at - session.clock) / 1000),
    advance(at: number, age: boolean) {
      if (disposed || session.owner !== member) return;
      const seconds = Math.max(0, (at - session.clock) / 1000); session.clock = Math.max(session.clock, at);
      if (age) session.world.elapse(seconds);
    },
    configure(nextView: View, nextActive: boolean) { if (!disposed) { member.view = nextView; member.active = nextActive; select(); } },
    release() {
      if (disposed) return; disposed = true; session.members.delete(member); select();
      if (!session.members.size) sessions.delete(identity);
    },
  };
}
let anonymous = 0;

import type { PlayerXpGain } from "@/features/economy/domain/player-xp-gain";

export const PLAYER_XP_FEEDBACK_MS = 2400;
const MAX_VISIBLE_MS = 5000;
export type PlayerXpBurst = Readonly<{ xp: number; fromLevel: number; toLevel: number }>;
type Effects = {
  show: (burst: PlayerXpBurst, entering: boolean) => void;
  hide: () => void;
  now: () => number;
  schedule: (finish: () => void, milliseconds: number) => unknown;
  cancel: (timer: unknown) => void;
};

/** Coalesces a short harvest burst, discards hidden history and never replays on mount. */
export function createPlayerXpPlayback(initialOwner: string | null, initial: readonly PlayerXpGain[], effects: Effects) {
  let owner = initialOwner, seen = new Set(initial.map(event => event.id));
  let burst: PlayerXpBurst | null = null, started = 0, timer: unknown = null, generation = 0;
  function clear() {
    generation++;
    if (timer !== null) effects.cancel(timer);
    timer = null; burst = null; effects.hide();
  }
  return {
    receive(nextOwner: string | null, events: readonly PlayerXpGain[], visible: boolean) {
      if (owner !== nextOwner) { clear(); owner = nextOwner; seen = new Set(events.map(event => event.id)); return; }
      const fresh = events.filter(event => {
        if (seen.has(event.id)) return false;
        seen.add(event.id);
        return event.ownerPublicId === owner && event.xp > 0;
      });
      while (seen.size > 64) seen.delete(seen.values().next().value!);
      if (!owner || !visible) { clear(); return; }
      if (!fresh.length) return;
      const entering = burst === null;
      if (entering) started = effects.now();
      burst = Object.freeze({ xp: (burst?.xp ?? 0) + fresh.reduce((sum, event) => sum + event.xp, 0),
        fromLevel: Math.min(burst?.fromLevel ?? Infinity, ...fresh.map(event => event.fromLevel)),
        toLevel: Math.max(burst?.toLevel ?? 0, ...fresh.map(event => event.toLevel)) });
      effects.show(burst, entering);
      if (timer !== null) effects.cancel(timer);
      const token = ++generation;
      timer = effects.schedule(() => { if (token === generation) clear(); }, Math.max(0,
        Math.min(PLAYER_XP_FEEDBACK_MS, started + MAX_VISIBLE_MS - effects.now())));
    },
    clear,
  };
}

/** A level crossing fills the old bar, then starts the new one; huge jumps use one cycle. */
export function playerXpFillFrames(previous: { level: number; ratio: number }, next: { level: number; ratio: number }) {
  return next.level > previous.level ? [
    { width: `${previous.ratio * 100}%`, offset: 0 },
    { width: "100%", offset: 0.4 }, { width: "100%", offset: 0.49 },
    { width: "0%", offset: 0.5 }, { width: `${next.ratio * 100}%`, offset: 1 },
  ] : [{ width: `${previous.ratio * 100}%` }, { width: `${next.ratio * 100}%` }];
}

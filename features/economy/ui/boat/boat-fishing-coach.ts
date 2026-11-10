export const BOAT_COACH_STORAGE_PREFIX = "zhiv.boat-controls.v1.";
export type BoatCoachView = { owner: string; learnedLift: boolean; completed: boolean; justCompleted: boolean };
export type BoatCoachObservation = { challengeId: string; stage: string; playing: boolean; held: boolean; tick: number; bar: number };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const seenWithoutStorage = new Set<string>();
export const boatCoachStorageKey = (owner: string) => BOAT_COACH_STORAGE_PREFIX + encodeURIComponent(owner);

function saveLesson(key: string, value: "seen" | "done", storage: Storage | null) {
  if (storage) try {
    storage.setItem(key, value);
    seenWithoutStorage.delete(key);
    return;
  } catch { /* A denied write still counts as a visit in this browser session. */ }
  seenWithoutStorage.add(key);
}

/** A previous practical lesson marked "done" counts as an introduction too. */
export function claimBoatFishingCourse(owner: string, storage: Storage | null) {
  const key = boatCoachStorageKey(owner);
  if (seenWithoutStorage.has(key)) return false;
  try {
    const value = storage?.getItem(key);
    if (value === "seen" || value === "done") return false;
  } catch { /* The in-memory receipt covers repeated visits. */ }
  saveLesson(key, "seen", storage);
  return true;
}

/** A cosmetic local lesson. Only actual advancing reel samples may complete it. */
export function createBoatFishingCoach(owner: string) {
  let view: BoatCoachView = { owner, learnedLift: false, completed: false, justCompleted: false };
  let previous: BoatCoachObservation | undefined, liftTicks = 0, releaseTicks = 0, releaseArmed = false;
  const set = (next: BoatCoachView) => { const changed = next.learnedLift !== view.learnedLift || next.completed !== view.completed || next.justCompleted !== view.justCompleted; view = next; return changed; };
  return {
    snapshot: () => view,
    restore(storage: Storage | null) {
      try { return set({ owner, learnedLift: false, completed: storage?.getItem(boatCoachStorageKey(owner)) === "done", justCompleted: false }); }
      catch { return false; }
    },
    reset(storage: Storage | null) {
      previous = undefined; liftTicks = 0; releaseTicks = 0; releaseArmed = false;
      saveLesson(boatCoachStorageKey(owner), "seen", storage);
      return set({ owner, learnedLift: false, completed: false, justCompleted: false });
    },
    observe(sample: BoatCoachObservation, storage: Storage | null) {
      const last = previous;
      previous = { ...sample };
      const active = sample.playing && sample.stage === "reeling";
      // Blocking input releases the line automatically. A fresh hold in this active segment
      // is required before a later falling zone can teach an intentional release.
      if (!active || last?.challengeId !== sample.challengeId) { releaseArmed = false; releaseTicks = 0; }
      if (active && view.learnedLift && sample.held) releaseArmed = true;
      if (view.completed) return view.justCompleted && (!sample.playing || sample.stage !== "reeling" || last?.challengeId !== sample.challengeId) ? set({ ...view, justCompleted: false }) : false;
      if (!sample.playing || sample.stage !== "reeling") return false;
      if (!last || last.challengeId !== sample.challengeId || !last.playing || last.stage !== "reeling" || sample.tick <= last.tick) return false;
      const ticks = Math.min(6, sample.tick - last.tick), movement = sample.bar - last.bar;
      if (!view.learnedLift && last.held && sample.held && movement > 0) liftTicks += ticks;
      if (view.learnedLift && releaseArmed && !last.held && !sample.held && movement < 0) releaseTicks += ticks;
      const learnedLift = liftTicks >= 2;
      if (learnedLift && sample.held) releaseArmed = true;
      const completed = learnedLift && releaseTicks >= 2;
      if (completed) saveLesson(boatCoachStorageKey(owner), "done", storage);
      return set({ owner, learnedLift, completed, justCompleted: completed });
    },
  };
}

export function boatCoachInstruction(view: BoatCoachView, stage: string) {
  if (view.completed) return null;
  if (stage === "casting" || stage === "soaking" || stage === "bite") return "Когда поплавок нырнёт, коснитесь воды или нажмите пробел, чтобы подсечь.";
  if (stage === "reeling") return view.learnedLift
    ? "Отпустите, чтобы опустить зелёную зону вслед за рыбой."
    : "Зажмите воду или пробел, чтобы поднять зелёную зону к рыбе.";
  return "Удерживайте воду или пробел для замаха. Отпустите, когда метка попадёт в зелёную зону.";
}

export const BOAT_COACH_STORAGE_PREFIX = "zhiv.boat-controls.v1.";
export type BoatCoachView = { owner: string; learnedLift: boolean; completed: boolean; justCompleted: boolean };
export type BoatCoachObservation = { challengeId: string; stage: string; playing: boolean; held: boolean; tick: number; bar: number };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export const boatCoachStorageKey = (owner: string) => BOAT_COACH_STORAGE_PREFIX + encodeURIComponent(owner);

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
      try { storage?.removeItem(boatCoachStorageKey(owner)); } catch { /* Hints still work without storage. */ }
      return set({ owner, learnedLift: false, completed: false, justCompleted: false });
    },
    observe(sample: BoatCoachObservation, storage: Storage | null) {
      const last = previous;
      previous = { ...sample };
      const active = sample.playing && sample.stage === "reeling";
      // A pause/blur releases input automatically. A fresh hold in this active segment
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
      if (completed) try { storage?.setItem(boatCoachStorageKey(owner), "done"); } catch { /* Completion is cosmetic and remains in memory. */ }
      return set({ owner, learnedLift, completed, justCompleted: completed });
    },
  };
}

export function boatCoachInstruction(view: BoatCoachView, stage: string) {
  if (view.completed) return null;
  if (stage === "casting" || stage === "soaking") return "2 · Дождитесь, когда поплавок нырнёт.";
  if (stage === "bite") return "Нажмите «Подсечь!», как только нырнёт поплавок.";
  if (stage === "reeling" || stage === "paused") return view.learnedLift
    ? "4 · Отпустите кнопку — дайте зелёной зоне опуститься."
    : "3 · Зажмите кнопку или пробел — зелёная зона поднимется.";
  return "1 · Зажмите кнопку или пробел, чтобы выбрать силу заброса. Отпустите, чтобы бросить.";
}
